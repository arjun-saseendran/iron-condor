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
 * Sequence: exit shorts first (reduces margin), then longs.
 *
 * ✅ FIX 1: trade.lotSize → trade.quantity (model uses quantity, lotSize does not exist)
 * product: always NRML — positions held till expiry, never intraday MIS
 */
export const executeMarketExit = async (trade, exitSide = 'FULL') => {
    const kc       = getKiteInstance();
    const exchange = trade.index === 'SENSEX' ? 'BFO' : 'NFO';
    const isLive   = process.env.LIVE_TRADING === 'true';
    const side     = exitSide?.toUpperCase() || 'FULL';

    console.log(`🚨 [EXECUTION] ${isLive ? 'LIVE' : 'PAPER'} Exit | ${trade.index} | Side: ${side}`);

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
                console.log(`📝 [PAPER] BUY (Cover) ${trade.quantity} ${leg.symbol}`);
                continue; // ✅ FIX: was falling through to live branch in paper mode
            } else {
                console.log(`⏳ Closing short: ${leg.symbol}...`);
                await kc.placeOrder('regular', {
                    exchange,
                    tradingsymbol:    leg.symbol,
                    transaction_type: 'BUY',
                    quantity:         trade.quantity,  // ✅ FIX 1: was trade.lotSize
                    order_type:       'MARKET',
                    market_protection: 1,
                    product:          'NRML',
                });
                console.log(`✅ Short closed: ${leg.symbol}`);
            }
        }

        // PHASE 2: EXIT LONGS (sell to close)
        for (const leg of longLegs) {
            if (!isLive) {
                console.log(`📝 [PAPER] SELL (Close) ${trade.quantity} ${leg.symbol}`);
                continue; // ✅ FIX: was falling through to live branch in paper mode
            } else {
                console.log(`⏳ Closing long: ${leg.symbol}...`);
                await kc.placeOrder('regular', {
                    exchange,
                    tradingsymbol:    leg.symbol,
                    transaction_type: 'SELL',
                    quantity:         trade.quantity,  // ✅ FIX 1: was trade.lotSize
                    order_type:       'MARKET',
                    market_protection: 1,
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
 *
 * product: always NRML — positions held till expiry
 * ✅ FIX 2: live mode now returns { success: true } — was falling off end of try
 *           block returning undefined, causing engine DB writes to fail silently
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

        // ✅ FIX: verify BUY complete before placing SELL — prevents naked position
        const waitComplete = async (orderId, symbol) => {
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 500));
                const orders = await kc.getOrders();
                const o = orders.find(x => x.order_id === orderId);
                if (!o) continue;
                if (o.status === 'COMPLETE') return;
                if (o.status === 'REJECTED') throw new Error(`Order REJECTED: ${symbol} — ${o.status_message || 'no reason'}`);
            }
            throw new Error(`Order timeout: ${symbol} did not complete in 5s`);
        };

        // Buy long first — no margin spike
        const product = 'NRML';
        console.log(`⏳ Buying long leg: ${buySymbol}... [${product}]`);
        const buyOrder = await kc.placeOrder('regular', {
            exchange,
            tradingsymbol:    buySymbol,
            transaction_type: 'BUY',
            quantity,
            order_type:       'MARKET',
                    market_protection: 1,
            product,
        });
        await waitComplete(buyOrder.order_id, buySymbol);
        console.log(`✅ Long leg confirmed: ${buySymbol}`);

        // Then sell short — only after BUY is confirmed
        console.log(`⏳ Selling short leg: ${sellSymbol}...`);
        let sellOrder;
        try {
            sellOrder = await kc.placeOrder('regular', {
                exchange,
                tradingsymbol:    sellSymbol,
                transaction_type: 'SELL',
                quantity,
                order_type:       'MARKET',
                    market_protection: 1,
                product:          'NRML',
            });
        } catch (sellErr) {
            // SELL failed — close the BUY to avoid naked long
            console.error(`❌ SELL failed (${sellSymbol}) — closing BUY leg ${buySymbol}`);
            try { await kc.placeOrder('regular', { exchange, tradingsymbol: buySymbol, transaction_type: 'SELL', quantity, order_type: 'MARKET', market_protection: 1, product: 'NRML' }); } catch (_) {}
            throw sellErr;
        }
        try {
            await waitComplete(sellOrder.order_id, sellSymbol);
        } catch (sellVerifyErr) {
            // SELL rejected — close BUY immediately
            console.error(`❌ SELL rejected (${sellSymbol}) — closing BUY leg ${buySymbol}`);
            try { await kc.placeOrder('regular', { exchange, tradingsymbol: buySymbol, transaction_type: 'SELL', quantity, order_type: 'MARKET', market_protection: 1, product: 'NRML' }); } catch (_) {}
            throw sellVerifyErr;
        }
        console.log(`✅ Short leg confirmed: ${sellSymbol}`);

        await sendCondorAlert(
            `🚀 <b>Entry Complete: ${index}</b>\n` +
            `Buy: ${buySymbol}\n` +
            `Sell: ${sellSymbol}\n` +
            `Qty: ${quantity}`
        );

        return { success: true };  // ✅ FIX 2: was missing — live mode returned undefined

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