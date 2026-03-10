// ─── Kite Symbol → Token Mapper ───────────────────────────────────────────────
// Runtime cache: kiteSymbol (tradingsymbol) → instrument_token (number)
//
// When we select strikes from the option chain, we cache the mapping so
// live prices from the KiteTicker (which uses instrument_token) can be
// looked up using Kite symbol names.
//
// Cache is populated in ironCondorEngine when strikes are selected.
// Cache is cleared at start of each trading day.
// ─────────────────────────────────────────────────────────────────────────────

const _cache = {};  // kiteSymbol → instrument_token (number)

export const cacheSymbol = (kiteSymbol, instrumentToken) => {
  if (kiteSymbol && instrumentToken) _cache[kiteSymbol] = Number(instrumentToken);
};

// Returns instrument_token (number) for a kite trading symbol, or 0
export const kiteSymbolToToken = (kiteSymbol) => {
  return _cache[kiteSymbol] || 0;
};

export const clearSymbolCache = () => {
  Object.keys(_cache).forEach(k => delete _cache[k]);
};

export const getCache = () => ({ ..._cache });

// ─── Kite index trading symbols ───────────────────────────────────────────────
const INDEX_SYMBOL_MAP = {
  NIFTY:  "NSE:NIFTY 50",
  SENSEX: "BSE:SENSEX",
};

export const getKiteIndexSymbol = (symbol) => {
  return INDEX_SYMBOL_MAP[symbol?.toUpperCase()] || `NSE:${symbol}`;
};

// ─── Next weekly expiry calculator ────────────────────────────────────────────
// NIFTY  → Tuesday  (day 2)
// SENSEX → Thursday (day 4)
export const getNextWeeklyExpiry = (symbol) => {
  const upper     = symbol?.toUpperCase();
  const targetDay = upper === "SENSEX" ? 4 : 2;

  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));

  for (let d = 0; d <= 7; d++) {
    const dt = new Date(ist);
    dt.setUTCDate(ist.getUTCDate() + d);
    // ✅ FIX: return "YYYY-MM-DD" string, not a Date object.
    //         getNearestExpiry in ironCondorEngine also returns a string.
    //         Returning a Date here caused symbol-building failures when callers
    //         passed this result to buildKiteSymbol (which expects a string split on "-").
    if (dt.getUTCDay() === targetDay) return dt.toISOString().split("T")[0];
  }
  return ist.toISOString().split("T")[0];
};