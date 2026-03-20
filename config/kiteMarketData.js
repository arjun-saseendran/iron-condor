// ─── Kite Market Data ─────────────────────────────────────────────────────────
// Option chain and LTP data using Kite REST API.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { getKiteInstance } from "./kiteConfig.js";

// ─── GET LTP for one or more "EXCHANGE:SYMBOL" strings ───────────────────────
// Returns { "NSE:NIFTY 50": { instrument_token, last_price }, ... }
export const getLTP = async (instrumentKeys) => {
  try {
    const kc       = getKiteInstance();
    const keysArr  = Array.isArray(instrumentKeys) ? instrumentKeys : [instrumentKeys];
    const response = await kc.getLTP(keysArr);
    return response || null;
  } catch (error) {
    console.error("❌ Kite LTP Error:", error.message);
    return null;
  }
};

// ─── GET OHLC (last close fallback) ──────────────────────────────────────────
export const getLastClose = async (instrumentKey) => {
  try {
    const kc       = getKiteInstance();
    const response = await kc.getOHLC([instrumentKey]);
    const data     = response?.[instrumentKey];
    return data?.ohlc?.close || null;
  } catch (error) {
    console.error("❌ Kite Last Close Error:", error.message);
    return null;
  }
};

// ─── GET PUT/CALL OPTION CHAIN via Kite instruments + LTP ────────────────────
// Returns array of rows compatible with what ironCondorEngine.fetchFullOptionChain expects:
// [{ strike_price, expiry, call_options: { instrument_key(token), market_data: { ltp } },
//    put_options: { instrument_key(token), market_data: { ltp } } }]
//
// Kite instruments dump is large — we cache it per exchange per session.
// ─────────────────────────────────────────────────────────────────────────────

const _instrumentCache = {};    // exchange → instruments array
const _instrumentCacheTime = {}; // exchange → timestamp

// ✅ FIX: reset instrument cache daily at midnight IST, not on a rolling 6h TTL.
//         With 6h TTL, a server running past midnight serves yesterday's instruments
//         at market open (9:15 IST) until 6h after last fetch.
//         Now: cache is always invalidated after midnight IST.
const _getMidnightISTTimestamp = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  // Midnight IST in UTC = 18:30 previous UTC day
  const midnightIST = new Date(Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()
  ) - (5.5 * 60 * 60 * 1000));
  return midnightIST.getTime();
};

// ✅ FIX: Export clearInstrumentCache so routes can force-bust the in-memory
//         cache when a deployment happens mid-session. Also added error logging
//         so getInstruments() failures are visible in server logs.
export const clearInstrumentCache = (exchange) => {
  if (exchange) {
    delete _instrumentCache[exchange];
    delete _instrumentCacheTime[exchange];
    console.log(`[CACHE] Cleared instrument cache for ${exchange}`);
  } else {
    Object.keys(_instrumentCache).forEach(k => delete _instrumentCache[k]);
    Object.keys(_instrumentCacheTime).forEach(k => delete _instrumentCacheTime[k]);
    console.log(`[CACHE] Cleared ALL instrument caches`);
  }
};

const _getInstruments = async (exchange) => {
  const now = Date.now();
  const lastMidnightIST = _getMidnightISTTimestamp();
  // Cache is valid if it was fetched AFTER today's midnight IST
  if (_instrumentCache[exchange] && _instrumentCacheTime[exchange] > lastMidnightIST) {
    console.log(`[CACHE] Using cached instruments for ${exchange} (${_instrumentCache[exchange].length} records)`);
    return _instrumentCache[exchange];
  }
  const kc = getKiteInstance();
  console.log(`[CACHE] Fetching fresh instruments for ${exchange} from Kite...`);
  try {
    const data = await kc.getInstruments([exchange]);
    if (!data || data.length === 0) {
      console.error(`[CACHE] ❌ Kite returned empty instruments for ${exchange}`);
      throw new Error(`Kite getInstruments("${exchange}") returned empty array`);
    }
    console.log(`[CACHE] ✅ Fetched ${data.length} instruments for ${exchange}`);
    _instrumentCache[exchange]     = data;
    _instrumentCacheTime[exchange] = now;
    return data;
  } catch (err) {
    console.error(`[CACHE] ❌ getInstruments("${exchange}") failed: ${err.message}`);
    throw err;
  }
};

export const getPCOptionChain = async (indexSymbol, expiryDate) => {
  try {
    const kc = getKiteInstance();

    // Determine exchange and underlying name from indexSymbol
    // indexSymbol format expected: "NSE:NIFTY 50" or "BSE:SENSEX"
    const isSENSEX   = indexSymbol.includes("SENSEX");
    const exchange   = isSENSEX ? "BFO" : "NFO";
    const underlying = isSENSEX ? "SENSEX" : "NIFTY";

    const instruments = await _getInstruments(exchange);

    // ── Diagnostics: log raw instrument sample so we can see real expiry format ──
    const sample = instruments.slice(0, 3);
    console.log(`[CHAIN] ${exchange} instruments total: ${instruments.length}`);
    console.log(`[CHAIN] Sample expiry values:`,
      sample.map(i => ({
        name: i.name,
        type: i.instrument_type,
        expiry: i.expiry,
        expiryType: typeof i.expiry,
        isDate: i.expiry instanceof Date,
        raw: String(i.expiry),
      }))
    );

    // Filter to options for this underlying + expiry
    const expiryTs = new Date(expiryDate).toISOString().split("T")[0];
    console.log(`[CHAIN] Looking for: name=${underlying} expiry=${expiryTs}`);

    // ✅ FIX: Kite JS client returns inst.expiry as a JS Date object.
    //         String(date) produces "Thu Mar 26 2026 00:00:00 GMT+0000" — splitting on "T"
    //         yields "" (empty string before "T" in "GMT") so comparison always fails.
    //         toDateStr() safely handles both Date objects and strings.
    const toDateStr = (expiry) => {
      if (!expiry) return "";
      if (expiry instanceof Date) return expiry.toISOString().split("T")[0];
      // Already "YYYY-MM-DD" string
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(expiry))) return String(expiry);
      // ISO string or other parseable format
      return new Date(expiry).toISOString().split("T")[0];
    };

    const options = instruments.filter(inst =>
      inst.name === underlying &&
      (inst.instrument_type === "CE" || inst.instrument_type === "PE") &&
      toDateStr(inst.expiry) === expiryTs
    );

    // Log what underlying names actually exist (helps catch "SENSEX" vs "BSE:SENSEX" etc.)
    if (options.length === 0) {
      const allNames = [...new Set(instruments.map(i => i.name))].slice(0, 10);
      const allExpiries = [...new Set(
        instruments
          .filter(i => i.name === underlying)
          .map(i => toDateStr(i.expiry))
      )].sort().slice(0, 10);
      console.error(`[CHAIN] ❌ No options found for name="${underlying}" expiry="${expiryTs}"`);
      console.error(`[CHAIN] Names in ${exchange}:`, allNames);
      console.error(`[CHAIN] Expiries for "${underlying}":`, allExpiries);
      return null;
    }

    console.log(`[CHAIN] ✅ Found ${options.length} options for ${underlying} expiry=${expiryTs}`);

    // Group by strike
    const strikeMap = {};
    for (const inst of options) {
      const strike = inst.strike;
      if (!strikeMap[strike]) strikeMap[strike] = { ce: null, pe: null };
      if (inst.instrument_type === "CE") strikeMap[strike].ce = inst;
      else                               strikeMap[strike].pe = inst;
    }

    // Fetch LTP for all option instruments
    const tradingSymbols = options.map(i => `${exchange}:${i.tradingsymbol}`);

    // Kite LTP accepts max 200 at a time
    // ✅ FIX: wrap each batch in try/catch — one failing batch was throwing and
    //         returning null for the entire chain, blocking entry completely
    const ltpMap = {};
    for (let i = 0; i < tradingSymbols.length; i += 200) {
      const batch = tradingSymbols.slice(i, i + 200);
      try {
        const response = await kc.getLTP(batch);
        if (response) Object.assign(ltpMap, response);
      } catch (batchErr) {
        console.error(`⚠️ LTP batch ${i/200 + 1} failed: ${batchErr.message} — skipping batch`);
      }
    }

    // Build chain rows in Upstox-compatible format (used by ironCondorEngine)
    const rows = Object.entries(strikeMap).map(([strike, { ce, pe }]) => ({
      strike_price: Number(strike),
      expiry:       expiryDate,
      call_options: ce ? {
        instrument_key: ce.instrument_token,   // instrument_token used as "key"
        market_data:    {
          ltp:    ltpMap[`${exchange}:${ce.tradingsymbol}`]?.last_price || 0,
          oi:     0,
          volume: 0,
        },
        tradingsymbol: ce.tradingsymbol,
      } : null,
      put_options: pe ? {
        instrument_key: pe.instrument_token,
        market_data:    {
          ltp:    ltpMap[`${exchange}:${pe.tradingsymbol}`]?.last_price || 0,
          oi:     0,
          volume: 0,
        },
        tradingsymbol: pe.tradingsymbol,
      } : null,
    }));

    return rows;

  } catch (error) {
    console.error("❌ Kite PC Option Chain Error:", error.message);
    return null;
  }
};

// ─── GET INSTRUMENTS for a specific symbol+expiry (used by option chain route) ─
export const getOptionInstruments = async (symbol, expiryDate) => {
  const isSENSEX  = symbol.toUpperCase() === "SENSEX";
  const exchange  = isSENSEX ? "BFO" : "NFO";
  const underlying = symbol.toUpperCase();

  const instruments = await _getInstruments(exchange);
  const expiryTs    = new Date(expiryDate).toISOString().split("T")[0];

  // ✅ FIX: same Date-to-string fix as getPCOptionChain
  const toDateStr = (expiry) => {
    if (expiry instanceof Date) return expiry.toISOString().split("T")[0];
    return new Date(expiry).toISOString().split("T")[0];
  };

  return instruments.filter(inst => {
    return (
      inst.name === underlying &&
      (inst.instrument_type === "CE" || inst.instrument_type === "PE") &&
      toDateStr(inst.expiry) === expiryTs
    );
  });
};