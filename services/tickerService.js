import { getKiteInstance } from './kiteService.js';
import ActiveTrade from '../models/activeTradeModel.js';
import { executeMarginSafeExit } from './orderService.js';

let ticker = null;
const lastPrices = {}; 

export const startTicker = async () => {
    const kc = getKiteInstance();
    ticker = kc.ticker();

    ticker.connect();

    ticker.on("connect", async () => {
        // Only subscribe to trades that are still 'ACTIVE'
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
        ticks.forEach(tick => {
            lastPrices[tick.instrument_token] = tick.last_price;
        });

        // CRITICAL: Fetch ONLY 'ACTIVE' trades from MongoDB
        // If a trade is 'MANUAL_OVERRIDE', it will be ignored by this loop.
        const trades = await ActiveTrade.find({ status: 'ACTIVE' });

        for (const trade of trades) {
            const { tokens, callSpreadEntryPremium, putSpreadEntryPremium, bookedCallPremium, bookedPutPremium, index, callSellStrike, putSellStrike } = trade;

            const spotLTP = lastPrices[tokens.spotIndex];
            const callSellLTP = lastPrices[tokens.callSell];
            const callBuyLTP = lastPrices[tokens.callBuy];
            const putSellLTP = lastPrices[tokens.putSell];

            if (!spotLTP || !callSellLTP) continue;

            // 1. THE KILLSWITCH: SPOT TOUCHES STRIKE
            if (spotLTP >= callSellStrike || spotLTP <= putSellStrike) {
                console.log(`🛑 [${index} KILLSWITCH] Spot (${spotLTP}) touched Strike. Locking MANUAL_OVERRIDE in DB.`);
                
                // Update MongoDB so this persists through restarts
                trade.status = 'MANUAL_OVERRIDE';
                await trade.save();
                
                // Stop monitoring this trade immediately
                continue; 
            }

            // 2. 4x STOP LOSS LOGIC (Only runs if status is 'ACTIVE')
            const currentCallValue = Math.abs((lastPrices[tokens.callBuy] || 0) - callSellLTP);
            const currentPutValue = Math.abs((lastPrices[tokens.putBuy] || 0) - putSellLTP);

            const callSLTrigger = (Math.abs(callSpreadEntryPremium) * 4) + bookedCallPremium + bookedPutPremium;
            const putSLTrigger = (Math.abs(putSpreadEntryPremium) * 4) + bookedCallPremium + bookedPutPremium;

            if (currentCallValue >= callSLTrigger) {
                console.log(`🚨 [${index}] CALL SL HIT. Executing Exit...`);
                await handleExit(trade, 'CALL');
            } else if (currentPutValue >= putSLTrigger) {
                console.log(`🚨 [${index}] PUT SL HIT. Executing Exit...`);
                await handleExit(trade, 'PUT');
            }
        }
    });
};

async function handleExit(trade, side) {
    trade.status = 'EXITING'; // Prevent double-triggering
    await trade.save();

    const { symbols, index } = trade;
    const sellSym = side === 'CALL' ? symbols.callSell : symbols.putSell;
    const buySym = side === 'CALL' ? symbols.callBuy : symbols.putBuy;

    try {
        await executeMarginSafeExit(sellSym, buySym, index === 'SENSEX' ? 'BFO' : 'NFO', index);
        trade.status = 'EXITED';
        await trade.save();
    } catch (err) {
        console.error("❌ Exit Failed:", err.message);
        trade.status = 'FAILED_EXIT'; // Alerting you in MongoDB
        await trade.save();
    }
}