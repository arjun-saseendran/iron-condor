import { getKiteInstance } from './kiteService.js';

export const executeMarginSafeExit = async (sellSymbol, buySymbol, exchange, index) => {
    const kc = getKiteInstance();
    // Defaulting to 5 lots as per your user summary
    const quantity = index === 'NIFTY' ? (65 * 5) : (20 * 5); 

    console.log(`🚨 [ORDER SERVICE] Executing Margin-Safe Exit for ${index}`);

    try {
        // STEP 1: EXIT SELL LEG (The Short) - Most important for margin
        console.log(`⏳ Closing Short Leg: ${sellSymbol}...`);
        const sellExit = await kc.placeOrder("regular", {
            exchange: exchange,
            tradingsymbol: sellSymbol,
            transaction_type: "BUY",
            quantity: quantity,
            order_type: "MARKET",
            product: "NRML"
        });
        console.log(`✅ Short Leg Closed. ID: ${sellExit.order_id}`);

        // STEP 2: EXIT BUY LEG (The Hedge)
        console.log(`⏳ Closing Long Leg: ${buySymbol}...`);
        const buyExit = await kc.placeOrder("regular", {
            exchange: exchange,
            tradingsymbol: buySymbol,
            transaction_type: "SELL",
            quantity: quantity,
            order_type: "MARKET",
            product: "NRML"
        });
        console.log(`✅ Long Leg Closed. ID: ${buyExit.order_id}`);

        return { sellExit, buyExit };
    } catch (error) {
        console.error('❌ CRITICAL: Order Execution Failed!', error.message);
        throw error;
    }
};