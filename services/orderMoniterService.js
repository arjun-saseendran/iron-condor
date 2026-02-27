import { getKiteInstance } from './kiteService.js';

/**
 * Automatically fetches the last 4 completed orders for an index (NIFTY/SENSEX),
 * extracts strikes from symbols, and calculates average net premiums.
 */
export const autoFetchAndCalculate = async (index) => {
    const kc = getKiteInstance();
    
    try {
        console.log(`🔍 [DETECTIVE] Fetching recent ${index} orders from Kite...`);
        const orders = await kc.getOrders();

        // 1. Filter for COMPLETED orders for the specific index
        const indexOrders = orders.filter(o => 
            o.status === 'COMPLETE' && 
            o.tradingsymbol.startsWith(index)
        );

        if (indexOrders.length < 4) {
            console.error(`❌ Found only ${indexOrders.length} orders. Need 4 legs of Iron Condor.`);
            return null;
        }

        // 2. Take the 4 most recent orders (The current Iron Condor)
        const recent4 = indexOrders.slice(-4);

        const tradeData = {
            symbols: {},
            tokens: { 
                // Hardcoded Index Tokens (Standard for Kite)
                spotIndex: index === 'SENSEX' ? 265 : 256265 
            },
            strikes: {},
            netPremiums: { call: 0, put: 0 }
        };

        // Storage for calculating weighted averages
        const legs = {
            callSell: { symbol: '', buyPrice: 0, sellPrice: 0, token: 0, strike: 0 },
            callBuy:  { symbol: '', buyPrice: 0, sellPrice: 0, token: 0 },
            putSell:  { symbol: '', buyPrice: 0, sellPrice: 0, token: 0, strike: 0 },
            putBuy:   { symbol: '', buyPrice: 0, sellPrice: 0, token: 0 }
        };

        recent4.forEach(order => {
            const sym = order.tradingsymbol;
            const isCall = sym.endsWith('CE');
            const isSell = order.transaction_type === 'SELL';
            
            // Regex to extract the strike (looks for 5-6 digits in the symbol)
            const strikeMatch = sym.match(/\d{5,6}/);
            const strike = strikeMatch ? parseInt(strikeMatch[0]) : 0;

            if (isCall) {
                if (isSell) {
                    legs.callSell = { symbol: sym, sellPrice: order.average_price, token: order.instrument_token, strike };
                } else {
                    legs.callBuy = { symbol: sym, buyPrice: order.average_price, token: order.instrument_token };
                }
            } else {
                if (isSell) {
                    legs.putSell = { symbol: sym, sellPrice: order.average_price, token: order.instrument_token, strike };
                } else {
                    legs.putBuy = { symbol: sym, buyPrice: order.average_price, token: order.instrument_token };
                }
            }
        });

        // 3. Final Data Assembly
        return {
            index,
            callSellStrike: legs.callSell.strike,
            putSellStrike: legs.putSell.strike,
            callSpreadEntryPremium: (legs.callBuy.buyPrice - legs.callSell.sellPrice),
            putSpreadEntryPremium: (legs.putBuy.buyPrice - legs.putSell.sellPrice),
            symbols: {
                callSell: legs.callSell.symbol,
                callBuy: legs.callBuy.symbol,
                putSell: legs.putSell.symbol,
                putBuy: legs.putBuy.symbol
            },
            tokens: {
                spotIndex: tradeData.tokens.spotIndex,
                callSell: legs.callSell.token,
                callBuy: legs.callBuy.token,
                putSell: legs.putSell.token,
                putBuy: legs.putBuy.token
            }
        };

    } catch (error) {
        console.error("❌ [DETECTIVE ERROR]:", error.message);
        return null;
    }
};