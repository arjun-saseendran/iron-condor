import { getKiteInstance } from "./kiteService.js";

export const calculateNetPremium = async (sellSymbol, buySymbol) => {
  const kc = getKiteInstance();

  try {
    const allOrders = await kc.getOrders();
    const completedOrders = allOrders.filter(
      (order) => order.status === "COMPLETE",
    ); //

    // Normalize symbols: removes spaces and matches regardless of suffixes (NFO/BFO)
    const findOrders = (target, type) => {
      const cleanTarget = String(target).toUpperCase().replace(/\s/g, "");
      return completedOrders.filter((order) => {
        const cleanOrderSym = order.tradingsymbol
          .toUpperCase()
          .replace(/\s/g, "");
        return (
          cleanOrderSym.includes(cleanTarget) && order.transaction_type === type
        );
      });
    };

    const sellLegs = findOrders(sellSymbol, "SELL");
    const buyLegs = findOrders(buySymbol, "BUY");

    if (sellLegs.length === 0 || buyLegs.length === 0) {
      console.log(`⚠️ [MONITOR] Symbol mismatch: ${sellSymbol} not found.`);
      return null;
    }

    const getAvg = (orders) => {
      let val = 0,
        qty = 0;
      orders.forEach((o) => {
        val += o.average_price * o.filled_quantity;
        qty += o.filled_quantity;
      });
      return val / qty;
    };

    const net = getAvg(sellLegs) - getAvg(buyLegs);
    return Math.round(net * 100) / 100;
  } catch (err) {
    console.error("❌ [MONITOR] Kite Error:", err.message);
    return null;
  }
};
