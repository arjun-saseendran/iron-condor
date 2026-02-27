import { getKiteInstance } from './kiteService.js';

export const fetchAndCategorizePositions = async () => {
  const kc = getKiteInstance();
  
  try {
    // Fetch positions from Kite
    const positions = await kc.getPositions();

    // Kite returns 'net' (overall including carry forward) and 'day' (only today).
    // For Iron Condors, we evaluate 'net' to see the true open state.
    const netPositions = positions.net;

    // Filter for Active Positions (Open Quantity is not 0)
    const activePositions = netPositions.filter(pos => pos.quantity !== 0);

    // Filter for Closed Positions (Quantity is 0, but we traded it today)
    // We check if buy or sell quantity > 0 to ensure we actually interacted with it today
    const closedPositions = netPositions.filter(pos => pos.quantity === 0 && (pos.day_buy_quantity > 0 || pos.day_sell_quantity > 0));

    // Optional: Calculate today's realized PnL from closed positions
    let intradayRealizedPnL = 0;
    closedPositions.forEach(pos => {
      intradayRealizedPnL += pos.pnl; // Kite provides the live PnL field
    });

    console.log(`📊 Fetched Positions: ${activePositions.length} Active, ${closedPositions.length} Closed.`);

    return {
      active: activePositions,
      closed: closedPositions,
      intradayRealizedPnL,
      rawNetPositions: netPositions 
    };

  } catch (error) {
    console.error('❌ Error fetching positions from Kite:', error.message);
    throw error;
  }
};