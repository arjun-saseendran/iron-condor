import { KiteTicker } from 'kiteconnect'; // ⬅️ NEW: Using the specific Ticker constructor
import { getKiteInstance } from './kiteService.js';
import ActiveTrade from '../models/activeTradeModel.js';
import { sendTelegramAlert } from './telegramService.js';

export let lastPrices = {}; 

export const initTicker = async () => {
    const kc = getKiteInstance();
    
    // 🛠️ FIX: Initialize the Ticker using the constructor
    // You need the API Key and the Access Token (which is kc.access_token)
    const ticker = new KiteTicker({
        api_key: kc.api_key,
        access_token: kc.access_token
    });

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
            ].filter(t => t); 

            ticker.subscribe(tokens);
            ticker.setMode(ticker.modeFull, tokens);
        }
    });

    ticker.on("ticks", async (ticks) => {
        ticks.forEach(tick => {
            lastPrices[tick.instrument_token] = tick.last_price;
        });

        const activeTrade = await ActiveTrade.findOne({ status: 'ACTIVE' });
        if (!activeTrade) return;

        const { tokens, callSpreadEntryPremium, putSpreadEntryPremium, totalEntryPremium, bufferPremium, isIronButterfly, tradeType } = activeTrade;

        const currentCallNet = tokens.callSell ? Math.abs((lastPrices[tokens.callSell] || 0) - (lastPrices[tokens.callBuy] || 0)) : 0;
        const currentPutNet = tokens.putSell ? Math.abs((lastPrices[tokens.putSell] || 0) - (lastPrices[tokens.putBuy] || 0)) : 0;

        // --- 70% DECAY ALERTS ---
        if (!activeTrade.alertsSent.call70Decay && tradeType !== 'PUT_SPREAD' && currentCallNet <= (callSpreadEntryPremium * 0.3)) {
            sendTelegramAlert(`🟢 <b>70% DECAY: ${activeTrade.index} CALL</b>\nEntry: ₹${callSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentCallNet.toFixed(2)}`);
            activeTrade.alertsSent.call70Decay = true;
            await activeTrade.save();
        }

        if (!activeTrade.alertsSent.put70Decay && tradeType !== 'CALL_SPREAD' && currentPutNet <= (putSpreadEntryPremium * 0.3)) {
            sendTelegramAlert(`🟢 <b>70% DECAY: ${activeTrade.index} PUT</b>\nEntry: ₹${putSpreadEntryPremium.toFixed(2)}\nCurrent: ₹${currentPutNet.toFixed(2)}`);
            activeTrade.alertsSent.put70Decay = true;
            await activeTrade.save();
        }

        // --- STOP LOSS LOGIC ---
        let triggerExit = false;
        let exitReason = "";

        if (isIronButterfly) {
            const maxLossLimit = totalEntryPremium * 2; 
            const currentTotalValue = currentCallNet + currentPutNet;
            if (currentTotalValue >= maxLossLimit) {
                triggerExit = true;
                exitReason = `Iron Butterfly Global SL Hit (Value: ₹${currentTotalValue.toFixed(2)})`;
            }
        } else {
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

        if (triggerExit && activeTrade.status === 'ACTIVE') {
            activeTrade.status = 'EXITING';
            await activeTrade.save();
            sendTelegramAlert(`🚨 <b>STOP LOSS HIT: ${activeTrade.index}</b>\nReason: ${exitReason}`);
            await executeMarketExit(activeTrade);
        }
    });

    ticker.on("error", (err) => console.error("❌ Ticker Error:", err));
    ticker.on("close", (reason) => console.warn("📡 Ticker Connection Closed:", reason));
};

const executeMarketExit = async (trade) => {
    const kc = getKiteInstance();
    try {
        const legs = [
            { symbol: trade.symbols.callSell, type: "BUY" },
            { symbol: trade.symbols.callBuy, type: "SELL" },
            { symbol: trade.symbols.putSell, type: "BUY" },
            { symbol: trade.symbols.putBuy, type: "SELL" }
        ].filter(leg => leg.symbol);

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
        sendTelegramAlert(`✅ <b>Exit Complete: ${trade.index}</b>`);
    } catch (err) {
        trade.status = 'FAILED_EXIT';
        await trade.save();
        sendTelegramAlert(`❌ <b>CRITICAL: Exit Failed</b>\nError: ${err.message}`);
    }
};