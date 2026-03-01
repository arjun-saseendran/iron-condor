import { getKiteInstance } from './kiteService.js';
import ActiveTrade from '../models/activeTradeModel.js';

const getActiveIndexForToday = () => {
    const day = new Date().getDay();
    if (day === 1 || day === 2) return 'NIFTY';
    if (day === 3 || day === 4) return 'SENSEX';
    return null; 
};

export const scanAndSyncOrders = async () => {
    const index = getActiveIndexForToday();
    if (!index) return;

    const kc = getKiteInstance();
    try {
        const orders = await kc.getOrders();
        const todayCompletedOrders = orders.filter(o => o.status === 'COMPLETE' && o.tradingsymbol.startsWith(index));

        let activeTrade = await ActiveTrade.findOne({ index, status: 'ACTIVE' });

        // ==========================================
        // SCENARIO A: ROLLING (Firefight OR Trending)
        // ==========================================
        if (activeTrade) {
            // Find orders that DO NOT match our currently saved active symbols
            const newOrders = todayCompletedOrders.filter(o => 
                o.tradingsymbol !== activeTrade.symbols.callSell &&
                o.tradingsymbol !== activeTrade.symbols.callBuy &&
                o.tradingsymbol !== activeTrade.symbols.putSell &&
                o.tradingsymbol !== activeTrade.symbols.putBuy
            );

            if (newOrders.length === 0) return; 

            let callRolled = false;
            let putRolled = false;
            const newLegs = { callSell: null, callBuy: null, putSell: null, putBuy: null };

            newOrders.forEach(order => {
                const isCall = order.tradingsymbol.endsWith('CE');
                const isSell = order.transaction_type === 'SELL';
                const strike = parseInt(order.tradingsymbol.match(/\d{5,6}/)[0]);
                const legData = { symbol: order.tradingsymbol, price: order.average_price, token: order.instrument_token, strike };

                if (isCall && isSell) { newLegs.callSell = legData; callRolled = true; }
                if (isCall && !isSell) newLegs.callBuy = legData;
                if (!isCall && isSell) { newLegs.putSell = legData; putRolled = true; }
                if (!isCall && !isSell) newLegs.putBuy = legData;
            });

            // TRENDING OR FIREFIGHT ROLL: Call Side
            if (callRolled && newLegs.callSell && newLegs.callBuy) {
                console.log("🔥 CALL ROLL DETECTED: Booking profit/loss into buffer...");
                activeTrade.bufferPremium += (activeTrade.callSpreadEntryPremium * 0.7); 
                activeTrade.callSpreadEntryPremium = newLegs.callSell.price - newLegs.callBuy.price;
                activeTrade.callSellStrike = newLegs.callSell.strike;
                activeTrade.symbols.callSell = newLegs.callSell.symbol;
                activeTrade.symbols.callBuy = newLegs.callBuy.symbol;
                activeTrade.tokens.callSell = newLegs.callSell.token;
                activeTrade.tokens.callBuy = newLegs.callBuy.token;
            }

            // TRENDING OR FIREFIGHT ROLL: Put Side
            if (putRolled && newLegs.putSell && newLegs.putBuy) {
                console.log("🔥 PUT ROLL DETECTED: Booking profit/loss into buffer...");
                activeTrade.bufferPremium += (activeTrade.putSpreadEntryPremium * 0.7); 
                activeTrade.putSpreadEntryPremium = newLegs.putSell.price - newLegs.putBuy.price;
                activeTrade.putSellStrike = newLegs.putSell.strike;
                activeTrade.symbols.putSell = newLegs.putSell.symbol;
                activeTrade.symbols.putBuy = newLegs.putBuy.symbol;
                activeTrade.tokens.putSell = newLegs.putSell.token;
                activeTrade.tokens.putBuy = newLegs.putBuy.token;
            }

            if (callRolled || putRolled) {
                activeTrade.totalEntryPremium = activeTrade.callSpreadEntryPremium + activeTrade.putSpreadEntryPremium;
                activeTrade.alertsSent = { call70Decay: false, put70Decay: false, firefightAlert: false };
                activeTrade.isIronButterfly = false; 
                await activeTrade.save();
                console.log(`✅ Trade Rolled. New Total Buffer: ${activeTrade.bufferPremium.toFixed(2)}`);
            }
        } 
        // ==========================================
        // SCENARIO B: BRAND NEW DAY 1 ENTRY (2-Leg or 4-Leg)
        // ==========================================
        else {
            if (todayCompletedOrders.length < 2) return; 

            // Scan backwards to find the most recent opening legs
            let ceSell, ceBuy, peSell, peBuy;
            for (let i = todayCompletedOrders.length - 1; i >= 0; i--) {
                const o = todayCompletedOrders[i];
                const isCall = o.tradingsymbol.endsWith('CE');
                const isSell = o.transaction_type === 'SELL';
                if (isCall && isSell && !ceSell) ceSell = o;
                if (isCall && !isSell && !ceBuy) ceBuy = o;
                if (!isCall && isSell && !peSell) peSell = o;
                if (!isCall && !isSell && !peBuy) peBuy = o;
            }

            let tradeType = null;
            let callNet = 0, putNet = 0;

            if (ceSell && ceBuy && peSell && peBuy) {
                tradeType = 'IRON_CONDOR';
                callNet = ceSell.average_price - ceBuy.average_price;
                putNet = peSell.average_price - peBuy.average_price;
            } else if (ceSell && ceBuy) {
                tradeType = 'CALL_SPREAD';
                callNet = ceSell.average_price - ceBuy.average_price;
            } else if (peSell && peBuy) {
                tradeType = 'PUT_SPREAD';
                putNet = peSell.average_price - peBuy.average_price;
            } else {
                return; // Incomplete spread, waiting for execution
            }

            const spotToken = index === 'SENSEX' ? 265 : 256265;
            const lotSize = index === 'NIFTY' ? parseInt(process.env.NIFTY_LOT_SIZE) : parseInt(process.env.SENSEX_LOT_SIZE);

            console.log(`🆕 New ${index} ${tradeType} Detected! Saving fresh entry.`);
            await ActiveTrade.create({
                index,
                tradeType,
                lotSize,
                callSpreadEntryPremium: callNet,
                putSpreadEntryPremium: putNet,
                totalEntryPremium: callNet + putNet,
                bufferPremium: 0,
                callSellStrike: ceSell ? parseInt(ceSell.tradingsymbol.match(/\d{5,6}/)[0]) : null,
                putSellStrike: peSell ? parseInt(peSell.tradingsymbol.match(/\d{5,6}/)[0]) : null,
                symbols: {
                    callSell: ceSell ? ceSell.tradingsymbol : null,
                    callBuy: ceBuy ? ceBuy.tradingsymbol : null,
                    putSell: peSell ? peSell.tradingsymbol : null,
                    putBuy: peBuy ? peBuy.tradingsymbol : null
                },
                tokens: {
                    spotIndex: spotToken,
                    callSell: ceSell ? ceSell.instrument_token : null,
                    callBuy: ceBuy ? ceBuy.instrument_token : null,
                    putSell: peSell ? peSell.instrument_token : null,
                    putBuy: peBuy ? peBuy.instrument_token : null
                }
            });
        }
    } catch (err) {
        console.error("❌ Order Monitor Error:", err.message);
    }
};