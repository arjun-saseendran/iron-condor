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
        // SCENARIO A: DAY 2 PARTIAL ROLL (FIREFIGHT)
        // ==========================================
        if (activeTrade) {
            // Find orders that DO NOT match our currently saved active symbols
            // This isolates the brand new legs you just opened today
            const newOrders = todayCompletedOrders.filter(o => 
                o.tradingsymbol !== activeTrade.symbols.callSell &&
                o.tradingsymbol !== activeTrade.symbols.callBuy &&
                o.tradingsymbol !== activeTrade.symbols.putSell &&
                o.tradingsymbol !== activeTrade.symbols.putBuy
            );

            if (newOrders.length === 0) return; // No new firefights detected today

            let callRolled = false;
            let putRolled = false;
            const newLegs = { callSell: null, callBuy: null, putSell: null, putBuy: null };

            // Categorize the newly discovered orders
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

            // If we rolled the CALL side
            if (callRolled && newLegs.callSell && newLegs.callBuy) {
                console.log("🔥 CALL FIREFIGHT DETECTED: Updating Call side buffer...");
                activeTrade.bufferPremium += (activeTrade.callSpreadEntryPremium * 0.7); // Add 70% of old premium to buffer
                activeTrade.callSpreadEntryPremium = newLegs.callSell.price - newLegs.callBuy.price;
                activeTrade.callSellStrike = newLegs.callSell.strike;
                activeTrade.symbols.callSell = newLegs.callSell.symbol;
                activeTrade.symbols.callBuy = newLegs.callBuy.symbol;
                activeTrade.tokens.callSell = newLegs.callSell.token;
                activeTrade.tokens.callBuy = newLegs.callBuy.token;
            }

            // If we rolled the PUT side
            if (putRolled && newLegs.putSell && newLegs.putBuy) {
                console.log("🔥 PUT FIREFIGHT DETECTED: Updating Put side buffer...");
                activeTrade.bufferPremium += (activeTrade.putSpreadEntryPremium * 0.7); // Add 70% of old premium to buffer
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
                activeTrade.isIronButterfly = false; // Reset IB status on a roll
                await activeTrade.save();
                console.log(`✅ Trade Rolled. New Total Buffer: ${activeTrade.bufferPremium.toFixed(2)}`);
            }

        } 
        // ==========================================
        // SCENARIO B: BRAND NEW DAY 1 ENTRY
        // ==========================================
        else {
            if (todayCompletedOrders.length < 4) return; 

            // Grab the last 4 orders assuming it's a fresh 4-leg entry
            const recent4 = todayCompletedOrders.slice(-4);
            const legs = { callSell: null, callBuy: null, putSell: null, putBuy: null };

            recent4.forEach(order => {
                const isCall = order.tradingsymbol.endsWith('CE');
                const isSell = order.transaction_type === 'SELL';
                const strikeMatch = order.tradingsymbol.match(/\d{5,6}/);
                const strike = strikeMatch ? parseInt(strikeMatch[0]) : 0;
                const legData = { symbol: order.tradingsymbol, price: order.average_price, token: order.instrument_token, strike };

                if (isCall && isSell) legs.callSell = legData;
                else if (isCall && !isSell) legs.callBuy = legData;
                else if (!isCall && isSell) legs.putSell = legData;
                else if (!isCall && !isSell) legs.putBuy = legData;
            });

            if (!legs.callSell || !legs.callBuy || !legs.putSell || !legs.putBuy) return;

            const callNet = legs.callSell.price - legs.callBuy.price;
            const putNet = legs.putSell.price - legs.putBuy.price;

            console.log(`🆕 New ${index} Iron Condor Detected! Saving fresh entry.`);
            await ActiveTrade.create({
                index,
                lotSize: index === 'NIFTY' ? parseInt(process.env.NIFTY_LOT_SIZE) : parseInt(process.env.SENSEX_LOT_SIZE),
                callSpreadEntryPremium: callNet,
                putSpreadEntryPremium: putNet,
                totalEntryPremium: callNet + putNet,
                bufferPremium: 0,
                callSellStrike: legs.callSell.strike,
                putSellStrike: legs.putSell.strike,
                symbols: {
                    callSell: legs.callSell.symbol, callBuy: legs.callBuy.symbol,
                    putSell: legs.putSell.symbol, putBuy: legs.putBuy.symbol
                },
                tokens: {
                    spotIndex: index === 'SENSEX' ? 265 : 256265, // BSE Sensex or NSE Nifty 50
                    callSell: legs.callSell.token, callBuy: legs.callBuy.token,
                    putSell: legs.putSell.token, putBuy: legs.putBuy.token
                }
            });
        }
    } catch (err) {
        console.error("❌ Order Monitor Error:", err.message);
    }
};