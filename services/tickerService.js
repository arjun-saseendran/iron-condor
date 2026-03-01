import { KiteTicker } from 'kiteconnect';
import { getAccessToken } from './kiteService.js';
import ActiveTrade from '../models/activeTradeModel.js';
import { executeMarginSafeExit } from './orderService.js';

let ticker = null;
export const lastPrices = {}; 

export const startTicker = async () => {
    const apiKey = process.env.KITE_API_KEY;
    const accessToken = getAccessToken();

    if (!apiKey || !accessToken) {
        console.error("❌ Cannot start Kite Ticker: Missing API Key or Access Token.");
        return;
    }

    // Initialize the official Zerodha WebSocket
    ticker = new KiteTicker({
        api_key: apiKey,
        access_token: accessToken
    });

    ticker.connect();

    ticker.on("connect", async () => {
        const activeTrades = await ActiveTrade.find({ status: 'ACTIVE' });
        const allTokens = activeTrades.flatMap(t => Object.values(t.tokens));
        
        if (allTokens.length > 0) {
            console.log(`📡 [TICKER] Subscribing to ${allTokens.length} active instruments.`);
            ticker.subscribe(allTokens);
            ticker.setMode(ticker.modeFull, allTokens);
        } else {
            console.log("ℹ️ [TICKER] No active trades to monitor at startup.");
        }
    });

    ticker.on("ticks", async (ticks) => {
        // Update live prices in memory
        ticks.forEach(tick => {
            lastPrices[tick.instrument_token] = tick.last_price;
        });

        const trades = await ActiveTrade.find({ status: 'ACTIVE' });

        for (const trade of trades) {
            const spotLTP = lastPrices[trade.tokens.spotIndex];
            
            // Current Net Premium = Buy LTP - Sell LTP (Since we are short, value is what it costs to close)
            const currentCallNet = Math.abs((lastPrices[trade.tokens.callBuy] || 0) - (lastPrices[trade.tokens.callSell] || 0));
            const currentPutNet = Math.abs((lastPrices[trade.tokens.putBuy] || 0) - (lastPrices[trade.tokens.putSell] || 0));

            if (!spotLTP) continue;

            // ==========================================
            // 🦋 1. IRON BUTTERFLY ATM DETECTION
            // ==========================================
            const atmThreshold = trade.index === 'NIFTY' ? 20 : 50; 
            
            if (!trade.isIronButterfly && 
               (Math.abs(spotLTP - trade.callSellStrike) <= atmThreshold || Math.abs(spotLTP - trade.putSellStrike) <= atmThreshold)) {
                
                console.log(`🦋 [${trade.index}] Sell Strike is now ATM. Converting to Iron Butterfly Mode.`);
                trade.isIronButterfly = true;
                await trade.save();
            }

            // ==========================================
            // 🚨 2. RISK MANAGEMENT LOGIC
            // ==========================================
            if (trade.isIronButterfly) {
                // IRON BUTTERFLY: 2% Global Stop Loss (Loss of 24 on a 12 entry)
                const totalCurrentValue = currentCallNet + currentPutNet;
                const maxLossThreshold = trade.totalEntryPremium * 2; 

                // If the cost to close minus the premium collected exceeds the 2% loss threshold
                if ((totalCurrentValue - trade.totalEntryPremium) >= maxLossThreshold) {
                    console.log(`🚨 [IB FATAL] 2% Capital SL Hit! Exiting EVERYTHING.`);
                    await handleExit(trade, 'ALL');
                }

            } else {
                // 🦅 STANDARD IRON CONDOR: 4x Leg Stop Loss & Alerts
                
                // A. The 70% Decay Alert (Profit)
                if (currentCallNet <= (trade.callSpreadEntryPremium * 0.3) && !trade.alertsSent.call70Decay) {
                    console.log(`📢 [ALERT] Call Spread decayed 70%!`);
                    trade.alertsSent.call70Decay = true;
                    await trade.save();
                }
                if (currentPutNet <= (trade.putSpreadEntryPremium * 0.3) && !trade.alertsSent.put70Decay) {
                    console.log(`📢 [ALERT] Put Spread decayed 70%!`);
                    trade.alertsSent.put70Decay = true;
                    await trade.save();
                }

                // B. The Firefight Alert (One side 70% profit, other side 3x loss)
                if ((trade.alertsSent.call70Decay && currentPutNet >= (trade.putSpreadEntryPremium * 3)) ||
                    (trade.alertsSent.put70Decay && currentCallNet >= (trade.callSpreadEntryPremium * 3))) {
                    
                    if (!trade.alertsSent.firefightAlert) {
                        console.log(`🔥 [ACTION REQUIRED] Firefight conditions met! Prepare to roll.`);
                        trade.alertsSent.firefightAlert = true;
                        await trade.save();
                    }
                }

                // C. The 4x Hard Stop Loss (+ Booked Buffer)
                const callSLTrigger = (trade.callSpreadEntryPremium * 4) + trade.bufferPremium;
                const putSLTrigger = (trade.putSpreadEntryPremium * 4) + trade.bufferPremium;

                if (currentCallNet >= callSLTrigger) {
                    console.log(`🚨 [SL HIT] Call Spread Hit 4x + Buffer (${callSLTrigger.toFixed(2)}). Exiting Call Side...`);
                    await handleExit(trade, 'CALL');
                } else if (currentPutNet >= putSLTrigger) {
                    console.log(`🚨 [SL HIT] Put Spread Hit 4x + Buffer (${putSLTrigger.toFixed(2)}). Exiting Put Side...`);
                    await handleExit(trade, 'PUT');
                }
            }
        }
    });
};

async function handleExit(trade, side) {
    trade.status = 'EXITING'; 
    await trade.save();

    try {
        const totalQty = trade.lotSize * process.env.DEFAULT_TRADE_LOTS;

        if (side === 'CALL' || side === 'ALL') {
            await executeMarginSafeExit(trade.symbols.callSell, trade.symbols.callBuy, totalQty, trade.index);
        }
        if (side === 'PUT' || side === 'ALL') {
            await executeMarginSafeExit(trade.symbols.putSell, trade.symbols.putBuy, totalQty, trade.index);
        }

        trade.status = 'EXITED';
        await trade.save();
    } catch (err) {
        console.error("❌ Exit Failed:", err.message);
        trade.status = 'FAILED_EXIT';
        await trade.save();
    }
}