import express from 'express';
import { getLTP, getLastClose, getPCOptionChain } from '../config/kiteMarketData.js';
import { getKiteIndexSymbol, getNextWeeklyExpiry } from '../services/kiteSymbolMapper.js';

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
    const expiryDate  = getNextWeeklyExpiry(symbol);
    const expiryLabel = expiryDate.toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
    const expiryStr = expiryDate.toISOString().split('T')[0];

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
    const pcChain = await getPCOptionChain(indexKey, expiryStr);
    if (!pcChain || pcChain.length === 0) {
      return res.status(500).json({ error: 'Failed to fetch option chain from Kite' });
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
    console.error('❌ Option Chain Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch option chain' });
  }
});

export default router;
