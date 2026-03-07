import { getKiteInstance } from '../config/kiteConfig.js';
import { sendCondorAlert } from '../services/telegramService.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * 🛡️ UNIVERSAL MARGIN-SAFE EXIT
 *
 * exitSide controls which legs to exit:
 *   'FULL' (default) → exit all 4 legs (both spreads)
 *   'CALL'           → exit call spread only (callSell + callBuy)
 *   'PUT'            → exit put spread only (putSell + putBuy)
 *   'BOTH'           → same as 'FULL' (Iron Butterfly full exit)
 *
 * ✅ FIX: engines call executeMarketExit(trade, exitSide) — second param was ignored.
 *         Partial exits (RESET after 1 SL) now correctly exit only the breached side.
 *
 * Sequence: exit shorts first (reduces margin), then longs.
 */
export const executeMarketExit = async (trade, exitSide = 'FULL') => {
    const kc       = getKiteInstance();
    const exchange = trade.index === 'SENSEX' ? 'BFO' : 'NFO';
    const isLive   = process.env.LIVE_TRADING === 'true';
    const side     = exitSide?.toUpperCase() || 'FULL';

    console.log(`🚨 [EXECUTION] ${isLive ? 'LIVE' : 'PAPER'} Exit | ${trade.index} | Side: ${side}`);

    // Build leg lists based on exitSide
    const includeCall = side === 'FULL' || side === 'BOTH' || side === 'CALL';
    const includePut  = side === 'FULL' || side === 'BOTH' || side === 'PUT';

    const shortLegs = [
        includeCall && trade.symbols.callSell ? { symbol: trade.symbols.callSell } : null,
        includePut  && trade.symbols.putSell  ? { symbol: trade.symbols.putSell  } : null,
    ].filter(Boolean);

    const longLegs = [
        includeCall && trade.symbols.callBuy ? { symbol: trade.symbols.callBuy } : null,
        includePut  && trade.symbols.putBuy  ? { symbol: trade.symbols.putBuy  } : null,
    ].filter(Boolean);

    try {
        // PHASE 1: EXIT SHORTS (buy to cover) — frees margin first
        for (const leg of shortLegs) {
            if (!isLive) {
                console.log(`📝 [PAPER] BUY (Cover) ${trade.lotSize} ${leg.symbol}`);
            } else {
                console.log(`⏳ Closing short: ${leg.symbol}...`);
                await kc.placeOrder('regular', {
                    exchange,
                    tradingsymbol:    leg.symbol,
                    transaction_type: 'BUY',
                    quantity:         trade.lotSize,
                    order_type:       'MARKET',
                    product:          'NRML',
                });
                console.log(`✅ Short closed: ${leg.symbol}`);
            }
        }

        // PHASE 2: EXIT LONGS (sell to close)
        for (const leg of longLegs) {
            if (!isLive) {
                console.log(`📝 [PAPER] SELL (Close) ${trade.lotSize} ${leg.symbol}`);
            } else {
                console.log(`⏳ Closing long: ${leg.symbol}...`);
                await kc.placeOrder('regular', {
                    exchange,
                    tradingsymbol:    leg.symbol,
                    transaction_type: 'SELL',
                    quantity:         trade.lotSize,
                    order_type:       'MARKET',
                    product:          'NRML',
                });
                console.log(`✅ Long closed: ${leg.symbol}`);
            }
        }

        await sendCondorAlert(
            `✅ <b>Exit Complete: ${trade.index}</b>\n` +
            `Side: ${side}\n` +
            `Mode: ${isLive ? 'LIVE 🔴' : 'PAPER 📝'}\n` +
            `Legs closed: ${shortLegs.length + longLegs.length}`
        );

        return { status: 'SUCCESS' };

    } catch (error) {
        console.error('❌ CRITICAL ORDER FAILURE:', error.message);
        await sendCondorAlert(
            `🚨 <b>EXIT FAILURE: ${trade.index}</b>\n` +
            `Side: ${side}\n` +
            `Error: ${error.message}\n` +
            `⚠️ Manual intervention required!`
        );
        throw error;
    }
};

/**
 * 🚀 MARGIN-SAFE ENTRY / ROLL
 * Buy long first (no margin spike), then sell short.
 * Used for entries and one-click roll adjustments.
 */
export const executeMarginSafeEntry = async (buySymbol, sellSymbol, quantity, index) => {
    const kc       = getKiteInstance();
    const exchange = index === 'SENSEX' ? 'BFO' : 'NFO';
    const isLive   = process.env.LIVE_TRADING === 'true';

    try {
        if (!isLive) {
            console.log(`📝 [PAPER] ENTRY: BUY ${quantity} ${buySymbol} | SELL ${quantity} ${sellSymbol}`);
            return { success: true };
        }

        // Buy long first — no margin spike
        console.log(`⏳ Buying long leg: ${buySymbol}...`);
        await kc.placeOrder('regular', {
            exchange,
            tradingsymbol:    buySymbol,
            transaction_type: 'BUY',
            quantity,
            order_type:       'MARKET',
            product:          'NRML',
        });
        console.log(`✅ Long leg placed: ${buySymbol}`);

        // Then sell short
        console.log(`⏳ Selling short leg: ${sellSymbol}...`);
        await kc.placeOrder('regular', {
            exchange,
            tradingsymbol:    sellSymbol,
            transaction_type: 'SELL',
            quantity,
            order_type:       'MARKET',
            product:          'NRML',
        });
        console.log(`✅ Short leg placed: ${sellSymbol}`);

        await sendCondorAlert(
            `🚀 <b>Entry Complete: ${index}</b>\n` +
            `Buy: ${buySymbol}\n` +
            `Sell: ${sellSymbol}\n` +
            `Qty: ${quantity}`
        );

        return { success: true };

    } catch (error) {
        console.error('❌ Margin Safe Entry Failed:', error.message);
        await sendCondorAlert(
            `🚨 <b>ENTRY FAILURE: ${index}</b>\n` +
            `Error: ${error.message}\n` +
            `⚠️ Check positions immediately!`
        );
        throw error;
    }
};