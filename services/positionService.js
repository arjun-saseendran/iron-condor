import { getKiteInstance } from '../config/kiteConfig.js';

/**
 * ✅ FIX: Removed unreliable `kc.access_token` guard.
 *         The KiteConnect SDK does not expose access_token as a public property,
 *         so the check always evaluated to falsy even with a valid token set.
 *         The SDK throws its own TokenException if the token is missing or expired,
 *         which is already caught and re-thrown below with a clear message.
 */
export const fetchAndCategorizePositions = async () => {
  const kc = getKiteInstance();

  try {
    const positions = await kc.getPositions();

    // Guard against unexpected response shapes
    if (!positions || !positions.net) {
      throw new Error('Unexpected response from Kite getPositions — missing `net` array.');
    }

    const netPositions = positions.net;

    // Active: open quantity != 0
    const activePositions = netPositions.filter(pos => pos.quantity !== 0);

    // Closed today: flat but transacted intraday
    const closedPositions = netPositions.filter(
      pos => pos.quantity === 0 && (pos.day_buy_quantity > 0 || pos.day_sell_quantity > 0)
    );

    // Use 'realised' (Kite v3 field name) with 'm2m' as fallback
    let intradayRealizedPnL = 0;
    closedPositions.forEach(pos => {
      intradayRealizedPnL += pos.realised ?? pos.m2m ?? 0;
    });

    console.log(`📊 Fetched Positions: ${activePositions.length} Active, ${closedPositions.length} Closed.`);

    return {
      active: activePositions,
      closed: closedPositions,
      intradayRealizedPnL,
      rawNetPositions: netPositions,
    };

  } catch (error) {
    const msg = error?.message || 'Unknown error from Kite API';
    console.error('❌ Error fetching positions from Kite:', msg);
    throw new Error(`Kite positions error: ${msg}`);
  }
};