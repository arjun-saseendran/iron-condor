import express from 'express';
import { getLTP, getLastClose, getPCOptionChain, clearInstrumentCache, getNearestExpiryFromInstruments } from '../config/kiteMarketData.js';
import { getKiteIndexSymbol } from '../services/kiteSymbolMapper.js';

const router = express.Router();

// ── Market hours check (IST) — Mon–Fri 09:15–15:30 ───────────────────────────
const isMarketOpen = () => {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day  = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return day >= 1 && day <= 5 && mins >= (9 * 60 + 15) && mins < (15 * 60 + 30);
};

router.get('/chain', async (req, res) => {
  const symbol      = (req.query.symbol || 'NIFTY').toUpperCase();
  const strikeRange = parseInt(req.query.strikes || '20');
  const isSENSEX    = symbol === 'SENSEX';
  const step        = isSENSEX ? 100 : 50;
  const indexKey    = getKiteIndexSymbol(symbol);

  try {
    // ── Expiry ────────────────────────────────────────────────────────────────
    // ✅ FIX: Use actual instrument data to find the nearest expiry instead of
    //         hardcoding the day-of-week (Thu for SENSEX). BSE/NSE move expiry
    //         to the previous day on market holidays (e.g. Holi 2026: SENSEX
    //         moved from Thu Mar 26 → Wed Mar 25). The hardcoded approach always
    //         missed these and returned zero instruments.
    const expiryStr   = await getNearestExpiryFromInstruments(symbol);
    const expiryLabel = new Date(expiryStr + "T00:00:00Z").toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });

    // ── Spot price ────────────────────────────────────────────────────────────
    let spotPrice    = null;
    let marketClosed = false;

    const spotQuote = await getLTP([indexKey]);
    if (spotQuote?.[indexKey]) {
      spotPrice = spotQuote[indexKey].last_price;
    } else {
      console.log(`📴 LTP unavailable for ${symbol} — fetching last close from Kite OHLC`);
      spotPrice    = await getLastClose(indexKey);
      marketClosed = true;
      if (!spotPrice) {
        return res.status(500).json({ error: `Cannot fetch spot price for ${symbol}` });
      }
    }

    const atmStrike = Math.round(spotPrice / step) * step;
    const strikes   = [];
    for (let i = -strikeRange; i <= strikeRange; i++) strikes.push(atmStrike + i * step);

    // ── Option chain ──────────────────────────────────────────────────────────
    console.log(`[CHAIN ROUTE] symbol=${symbol} indexKey=${indexKey} expiryStr=${expiryStr}`);
    const pcChain = await getPCOptionChain(indexKey, expiryStr);
    if (!pcChain || pcChain.length === 0) {
      console.error(`[CHAIN ROUTE] ❌ getPCOptionChain returned null/empty for ${symbol} expiry=${expiryStr}`);
      return res.status(500).json({
        error: `No option chain data found for ${symbol} expiry ${expiryStr}. Check server logs for details.`,
      });
    }

    console.log(`✅ [${marketClosed ? 'LAST SESSION' : 'LIVE'}] Kite option chain: ${pcChain.length} strikes for ${symbol}`);

    const chainMap = {};
    pcChain.forEach(row => { chainMap[row.strike_price] = row; });

    const formattedChain = strikes.map(strike => {
      const row    = chainMap[strike];
      const ceData = row?.call_options?.market_data || {};
      const peData = row?.put_options?.market_data  || {};
      const ceOi   = ceData.oi || 0;
      const peOi   = peData.oi || 0;
      return {
        strike,
        isATM: strike === atmStrike,
        ce: {
          ltp:   ceData.ltp ?? 0, chp: 0,
          oi:    ceOi ? (ceOi / 100000).toFixed(1) + 'L' : '0L', oiRaw: ceOi,
          vol:   ceData.volume ? (ceData.volume / 1000).toFixed(1) + 'K' : '0K',
        },
        pe: {
          ltp:   peData.ltp ?? 0, chp: 0,
          oi:    peOi ? (peOi / 100000).toFixed(1) + 'L' : '0L', oiRaw: peOi,
          vol:   peData.volume ? (peData.volume / 1000).toFixed(1) + 'K' : '0K',
        },
      };
    });

    res.json({
      spotPrice, atmStrike,
      expiry:     expiryLabel,
      marketClosed,
      dataSource: marketClosed ? 'KITE_LAST_SESSION' : 'KITE_LIVE',
      chain:      formattedChain,
    });

  } catch (error) {
    console.error('❌ Option Chain Error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch option chain from Kite', detail: error.message });
  }
});

// GET /api/options/cache-clear?exchange=BFO  (or NFO, or omit for all)
// Force-busts the in-memory instrument cache so next chain fetch re-downloads from Kite.
// Use this after deploying a fix without restarting the server.
router.get('/cache-clear', (req, res) => {
  const exchange = (req.query.exchange || '').toUpperCase() || null;
  clearInstrumentCache(exchange || undefined);
  res.json({ success: true, message: `Instrument cache cleared${exchange ? ' for ' + exchange : ' (all)'}` });
});

export default router;