// ─── Kite Market Data ─────────────────────────────────────────────────────────
// Option chain and LTP data using Kite REST API.
// Replaces upstoxConfig.js — all market data now from Kite only.
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

const INSTRUMENT_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const _getInstruments = async (exchange) => {
  const now = Date.now();
  if (_instrumentCache[exchange] && (now - _instrumentCacheTime[exchange]) < INSTRUMENT_CACHE_TTL) {
    return _instrumentCache[exchange];
  }
  const kc   = getKiteInstance();
  const data = await kc.getInstruments([exchange]);
  _instrumentCache[exchange]     = data;
  _instrumentCacheTime[exchange] = now;
  return data;
};

export const getPCOptionChain = async (indexSymbol, expiryDate) => {
  try {
    const kc = getKiteInstance();

    // Determine exchange and underlying name from indexSymbol
    // indexSymbol format expected: "NSE:NIFTY 50" or "BSE:SENSEX"
    const isNIFTY   = indexSymbol.includes("NIFTY");
    const isSENSEX  = indexSymbol.includes("SENSEX");
    const exchange  = isSENSEX ? "BFO" : "NFO";
    const underlying = isSENSEX ? "SENSEX" : "NIFTY";

    const instruments = await _getInstruments(exchange);

    // Filter to options for this underlying + expiry
    const expiryTs = new Date(expiryDate).toISOString().split("T")[0];
    // ✅ FIX: added parentheses around CE/PE check — without them the || breaks
    //         the && and PE instruments from ANY underlying sneak through,
    //         causing wrong strikes to be selected at entry.
    const options  = instruments.filter(inst =>
      inst.name === underlying &&
      (inst.instrument_type === "CE" || inst.instrument_type === "PE")
    ).filter(inst => {
      const instExpiry = inst.expiry instanceof Date
        ? inst.expiry.toISOString().split("T")[0]
        : String(inst.expiry).split("T")[0];
      return instExpiry === expiryTs;
    });

    if (options.length === 0) return null;

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
    const ltpMap = {};
    for (let i = 0; i < tradingSymbols.length; i += 200) {
      const batch    = tradingSymbols.slice(i, i + 200);
      const response = await kc.getLTP(batch);
      if (response) Object.assign(ltpMap, response);
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

  return instruments.filter(inst => {
    const instExpiry = inst.expiry instanceof Date
      ? inst.expiry.toISOString().split("T")[0]
      : String(inst.expiry).split("T")[0];
    return (
      inst.name === underlying &&
      (inst.instrument_type === "CE" || inst.instrument_type === "PE") &&
      instExpiry === expiryTs
    );
  });
};