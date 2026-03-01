import { getKiteInstance } from './kiteService.js';
import ActiveTrade from '../models/activeTradeModel.js';
import { sendTelegramAlert } from './telegramService.js';

export let lastPrices = {}; // Global store for live prices

/**
 * The Ticker Engine
 * Connects to Zerodha WebSockets and monitors risk in real-time.
 */
export const initTicker = async () => {
    const kc = getKiteInstance();
    const ticker = kc.ticker();

    ticker.connect();

    ticker.on("connect", async () => {
        console.log("📡 WebSocket Connected. Subscribing to tokens...");
        const activeTrade = await ActiveTrade.findOne({ status: 'ACTIVE' });
        
        if (activeTrade) {
            const tokens = [
                activeTrade.tokens.spotIndex,
                activeTrade.tokens.callSell,
                activeTrade.tokens.callBuy,
                activeTrade.tokens.putSell,
                activeTrade.tokens.putBuy
            ].filter(t => t); // Filter out nulls for 2-leg spreads

            ticker.subscribe(tokens);
            ticker.setMode(ticker.modeFull, tokens);
        }
    });

    ticker.on("ticks", async (ticks) => {
        // 1. Update our local price store
        ticks.forEach(tick => {
            lastPrices[tick.instrument_token] = tick.last_price;
        });

        // 2. Perform Risk Check
        const activeTrade = await ActiveTrade.findOne({ status: 'ACTIVE' });
        if (!activeTrade) return;

        const { tokens, callSpreadEntryPremium, putSpreadEntryPremium, totalEntryPremium, bufferPremium, isIronButterfly, tradeType } = activeTrade;

        // Calculate Current Spread Values (LTP Sell - LTP Buy)
        const currentCallNet = tokens.callSell ? Math.abs((lastPrices[tokens.callSell] || 0) - (lastPrices[tokens.callBuy] || 0)) : 0;
        const currentPutNet = tokens.putSell ? Math.abs((lastPrices[tokens.putSell] || 0) - (lastPrices[tokens.putBuy] || 0)) : 0;

        // ---------------------------------------------------------
        // LOGIC 1: 70% DECAY ALERTS (Time to book profits/Roll)
        // ---------------------------------------------------------
        if (!activeTrade.alertsSent.call70Decay && tradeType !== 'PUT_SPREAD' && currentCallNet <= (callSpreadEntryPremium * 0.3)) {
            sendTelegramAlert(`🟢 <b>70% DECAY: ${activeTrade.index} CALL</b>\n\nEntry: ₹${callSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentCallNet.toFixed(2)}\n\n<i>You can now roll or book profit.</i>`);
            activeTrade.alertsSent.call70Decay = true;
            await activeTrade.save();
        }

        if (!activeTrade.alertsSent.put70Decay && tradeType !== 'CALL_SPREAD' && currentPutNet <= (putSpreadEntryPremium * 0.3)) {
            sendTelegramAlert(`🟢 <b>70% DECAY: ${activeTrade.index} PUT</b>\n\nEntry: ₹${putSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentPutNet.toFixed(2)}\n\n<i>You can now roll or book profit.</i>`);
            activeTrade.alertsSent.put70Decay = true;
            await activeTrade.save();
        }

        // ---------------------------------------------------------
        // LOGIC 2: STOP LOSS MONITORING
        // ---------------------------------------------------------
        let triggerExit = false;
        let exitReason = "";

        if (isIronButterfly) {
            // Global 2% Rule for Iron Butterfly
            const maxLossLimit = totalEntryPremium * 2; 
            const currentTotalValue = currentCallNet + currentPutNet;
            if (currentTotalValue >= maxLossLimit) {
                triggerExit = true;
                exitReason = `Iron Butterfly Global SL Hit (Value: ₹${currentTotalValue.toFixed(2)})`;
            }
        } else {
            // Individual 4x SL Rule + Buffer
            const callSL = (callSpreadEntryPremium * 4) + bufferPremium;
            const putSL = (putSpreadEntryPremium * 4) + bufferPremium;

            if (tradeType !== 'PUT_SPREAD' && currentCallNet >= callSL) {
                triggerExit = true;
                exitReason = `CALL SL Hit (Current: ₹${currentCallNet.toFixed(2)} | Limit: ₹${callSL.toFixed(2)})`;
            } else if (tradeType !== 'CALL_SPREAD' && currentPutNet >= putSL) {
                triggerExit = true;
                exitReason = `PUT SL Hit (Current: ₹${currentPutNet.toFixed(2)} | Limit: ₹${putSL.toFixed(2)})`;
            }
        }

        // ---------------------------------------------------------
        // LOGIC 3: EXECUTE AUTO-EXIT
        // ---------------------------------------------------------
        if (triggerExit && activeTrade.status === 'ACTIVE') {
            activeTrade.status = 'EXITING';
            await activeTrade.save();

            console.error(`🚨 STOP LOSS TRIGGERED: ${exitReason}`);
            sendTelegramAlert(`🚨 <b>STOP LOSS HIT: ${activeTrade.index}</b>\n\nReason: ${exitReason}\n\n<i>Bot is firing market exit orders now!</i>`);

            await executeMarketExit(activeTrade);
        }
    });
};

/**
 * Fires Market Orders to close all legs of the spread
 */
const executeMarketExit = async (trade) => {
    const kc = getKiteInstance();
    try {
        // Exit strategy: Buy back the shorts, sell the longs (Market Orders)
        const legs = [
            { symbol: trade.symbols.callSell, type: "BUY" },
            { symbol: trade.symbols.callBuy, type: "SELL" },
            { symbol: trade.symbols.putSell, type: "BUY" },
            { symbol: trade.symbols.putBuy, type: "SELL" }
        ].filter(leg => leg.symbol); // Only exit legs that actually exist

        for (const leg of legs) {
            await kc.placeOrder("regular", {
                exchange: "NFO",
                tradingsymbol: leg.symbol,
                transaction_type: leg.type,
                quantity: trade.lotSize,
                order_type: "MARKET",
                product: "MIS"
            });
        }

        trade.status = 'EXITED';
        await trade.save();
        sendTelegramAlert(`✅ <b>Exit Complete: ${trade.index}</b>\nAll legs closed at market price.`);
        
    } catch (err) {
        trade.status = 'FAILED_EXIT';
        await trade.save();
        sendTelegramAlert(`❌ <b>CRITICAL: Exit Failed</b>\nError: ${err.message}\n<i>Please check Zerodha manually immediately!</i>`);
    }
};