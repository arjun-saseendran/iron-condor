import { getKiteInstance } from './kiteService.js';

export const executeMarginSafeExit = async (sellSymbol, buySymbol, totalQuantity, index) => {
    const kc = getKiteInstance();
    
    // NIFTY uses NFO (NSE Futures & Options), SENSEX uses BFO (BSE Futures & Options)
    const exchange = index === 'SENSEX' ? 'BFO' : 'NFO';

    console.log(`🚨 [EXECUTION] Margin-Safe Exit Triggered for ${index}`);
    console.log(`📊 Quantity: ${totalQuantity} | Exchange: ${exchange}`);

    try {
        // STEP 1: EXIT SHORT LEG FIRST (Buy to Cover)
        // This is critical. If you sell the long leg first, your margin shoots up and the broker might reject the order.
        console.log(`⏳ Closing Short Leg (Buying): ${sellSymbol}...`);
        const sellExit = await kc.placeOrder("regular", {
            exchange: exchange,
            tradingsymbol: sellSymbol,
            transaction_type: "BUY", // We are BUYING back the option we sold
            quantity: totalQuantity,
            order_type: "MARKET",
            product: "NRML"
        });
        console.log(`✅ Short Leg Closed. Order ID: ${sellExit.order_id}`);

        // STEP 2: EXIT LONG LEG SECOND (Sell to Close)
        console.log(`⏳ Closing Long Leg (Selling): ${buySymbol}...`);
        const buyExit = await kc.placeOrder("regular", {
            exchange: exchange,
            tradingsymbol: buySymbol,
            transaction_type: "SELL", // We are SELLING the option we bought
            quantity: totalQuantity,
            order_type: "MARKET",
            product: "NRML"
        });
        console.log(`✅ Long Leg Closed. Order ID: ${buyExit.order_id}`);

        return { sellExit, buyExit };
    } catch (error) {
        console.error('❌ CRITICAL ORDER FAILURE:', error.message);
        throw error;
    }
};