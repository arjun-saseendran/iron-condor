import express from 'express';
import { getLTP, getLastClose, getPCOptionChain, getOptionGreeks } from '../config/upstoxConfig.js';
import {
  getUpstoxIndexSymbol,
  buildUpstoxOptionSymbol,
  getNextWeeklyExpiry,
} from '../services/upstoxSymbolMapper.js';

const router = express.Router();

// ── Market hours check (IST) — Mon–Fri 09:15–15:30 ───────────────────────────
const isMarketOpen = () => {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day  = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return day >= 1 && day <= 5 && mins >= (9 * 60 + 15) && mins < (15 * 60 + 30);
};

// ── Format PC Option Chain response into standard shape ───────────────────────
const formatPCChain = (pcChain, strikes, atmStrike) => {
  const chainMap = {};
  pcChain.forEach(row => { chainMap[row.strike_price] = row; });

  return strikes.map(strike => {
    const row   = chainMap[strike];
    const ceRaw = row?.call_options?.market_data || {};
    const peRaw = row?.put_options?.market_data  || {};
    const ceOi  = ceRaw.oi || 0;
    const peOi  = peRaw.oi || 0;
    return {
      strike, isATM: strike === atmStrike,
      ce: {
        ltp:   ceRaw.ltp        ?? 0,
        chp:   ceRaw.net_change ?? 0,
        oi:    ceOi ? (ceOi / 100000).toFixed(1) + 'L' : '0L',
        oiRaw: ceOi,
        vol:   ceRaw.volume ? (ceRaw.volume / 1000).toFixed(1) + 'K' : '0K',
      },
      pe: {
        ltp:   peRaw.ltp        ?? 0,
        chp:   peRaw.net_change ?? 0,
        oi:    peOi ? (peOi / 100000).toFixed(1) + 'L' : '0L',
        oiRaw: peOi,
        vol:   peRaw.volume ? (peRaw.volume / 1000).toFixed(1) + 'K' : '0K',
      },
    };
  });
};

// ── Format Option Greeks response ─────────────────────────────────────────────
const formatGreeksChain = (greeks, strikes, atmStrike, symbol) => {
  return strikes.map(strike => {
    const ceKey = buildUpstoxOptionSymbol(symbol, strike, 'CE');
    const peKey = buildUpstoxOptionSymbol(symbol, strike, 'PE');
    const ce    = greeks[ceKey] || {};
    const pe    = greeks[peKey] || {};
    const ceOi  = ce.oi || 0;
    const peOi  = pe.oi || 0;
    return {
      strike, isATM: strike === atmStrike,
      ce: {
        ltp:   ce.last_price ?? 0,
        chp:   ce.cp ? ((ce.last_price - ce.cp) / ce.cp * 100) : 0,
        oi:    ceOi ? (ceOi / 100000).toFixed(1) + 'L' : '0L',
        oiRaw: ceOi,
        vol:   ce.volume ? (ce.volume / 1000).toFixed(1) + 'K' : '0K',
      },
      pe: {
        ltp:   pe.last_price ?? 0,
        chp:   pe.cp ? ((pe.last_price - pe.cp) / pe.cp * 100) : 0,
        oi:    peOi ? (peOi / 100000).toFixed(1) + 'L' : '0L',
        oiRaw: peOi,
        vol:   pe.volume ? (pe.volume / 1000).toFixed(1) + 'K' : '0K',
      },
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
router.get('/chain', async (req, res) => {
  const symbol      = (req.query.symbol || 'NIFTY').toUpperCase();
  const strikeRange = parseInt(req.query.strikes || '20');
  const step        = (symbol === 'SENSEX' || symbol === 'BANKEX') ? 100 : 50;
  const indexKey    = getUpstoxIndexSymbol(symbol);

  try {
    // ── 1. Expiry ─────────────────────────────────────────────────────────────
    const expiryDate  = getNextWeeklyExpiry(symbol);
    const expiryLabel = expiryDate.toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
    const expiryStr = expiryDate.toISOString().split('T')[0];

    // ── 2. Spot price — live LTP first, last-close fallback ───────────────────
    let spotPrice    = null;
    let marketClosed = false;

    const spotQuote = await getLTP([indexKey]);
    if (spotQuote?.[indexKey]) {
      spotPrice = spotQuote[indexKey].last_price;
    } else {
      // LTP unavailable — market is closed or token issue
      // Fall back to last session close from historical candle API
      console.log(`📴 LTP unavailable for ${symbol} — fetching last close from Upstox history`);
      spotPrice    = await getLastClose(indexKey);
      marketClosed = true;

      if (!spotPrice) {
        // Can't get any price at all
        return res.status(500).json({ error: `Cannot fetch spot price for ${symbol}` });
      }
      console.log(`✅ Last close for ${symbol}: ${spotPrice}`);
    }

    const atmStrike = Math.round(spotPrice / step) * step;
    const strikes   = [];
    for (let i = -strikeRange; i <= strikeRange; i++) strikes.push(atmStrike + i * step);

    // ── 3. Option chain data ──────────────────────────────────────────────────
    // PATH A: /v2/option/chain — best, works live AND after-hours (last session data)
    let formattedChain = null;

    const pcChain = await getPCOptionChain(indexKey, expiryStr);
    if (pcChain && Array.isArray(pcChain) && pcChain.length > 0) {
      console.log(`✅ [${marketClosed ? 'LAST SESSION' : 'LIVE'}] Upstox PC chain: ${pcChain.length} strikes for ${symbol}`);
      formattedChain = formatPCChain(pcChain, strikes, atmStrike);
    }

    // PATH B: /v3/market-quote/option-greek — live only, has LTP+OI+Vol
    if (!formattedChain && !marketClosed) {
      console.log('📡 PC chain failed — trying option-greek batch...');
      const instruments = [];
      strikes.forEach(s => {
        instruments.push(buildUpstoxOptionSymbol(symbol, s, 'CE'));
        instruments.push(buildUpstoxOptionSymbol(symbol, s, 'PE'));
      });
      const greeks = await getOptionGreeks(instruments);
      if (greeks) {
        console.log(`✅ option-greek: ${Object.keys(greeks).length} instruments`);
        formattedChain = formatGreeksChain(greeks, strikes, atmStrike, symbol);
      }
    }

    // PATH C: LTP only — last resort, no OI
    if (!formattedChain && !marketClosed) {
      console.log('📡 option-greek failed — falling back to LTP only (no OI)...');
      const instruments = [];
      strikes.forEach(s => {
        instruments.push(buildUpstoxOptionSymbol(symbol, s, 'CE'));
        instruments.push(buildUpstoxOptionSymbol(symbol, s, 'PE'));
      });
      const quotes = await getLTP(instruments);
      if (!quotes) return res.status(500).json({ error: 'All Upstox market data endpoints failed' });

      formattedChain = strikes.map(strike => {
        const ce = quotes[buildUpstoxOptionSymbol(symbol, strike, 'CE')] || {};
        const pe = quotes[buildUpstoxOptionSymbol(symbol, strike, 'PE')] || {};
        return {
          strike, isATM: strike === atmStrike,
          ce: { ltp: ce.last_price ?? 0, chp: 0, oi: '—', oiRaw: 0, vol: '—' },
          pe: { ltp: pe.last_price ?? 0, chp: 0, oi: '—', oiRaw: 0, vol: '—' },
        };
      });
    }

    if (!formattedChain) {
      return res.status(500).json({ error: 'Failed to build option chain' });
    }

    res.json({
      spotPrice,
      atmStrike,
      expiry:       expiryLabel,
      marketClosed,
      dataSource:   marketClosed ? 'UPSTOX_LAST_SESSION' : 'UPSTOX_LIVE',
      chain:        formattedChain,
    });

  } catch (error) {
    console.error('❌ Option Chain Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch option chain' });
  }
});

export default router;