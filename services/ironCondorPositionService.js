import { getKiteInstance } from '../config/kiteConfig.js';

export const fetchAndCategorizePositions = async () => {
  const kc = getKiteInstance();

  // Guard: ensure the kite instance has a valid access token before calling API
  if (!kc.access_token) {
    throw new Error('Kite access token not set. Please complete Zerodha login first.');
  }

  try {
    const positions = await kc.getPositions();

    // kiteconnect returns { day: [...], net: [...] }
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
      rawNetPositions: netPositions
    };

  } catch (error) {
    // Surface Kite API errors clearly (e.g. TokenException, NetworkException)
    const msg = error?.message || 'Unknown error from Kite API';
    console.error('❌ Error fetching positions from Kite:', msg);
    throw new Error(`Kite positions error: ${msg}`);
  }
};
