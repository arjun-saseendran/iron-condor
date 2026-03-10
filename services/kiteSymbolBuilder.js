// ─── Kite Symbol Builder ──────────────────────────────────────────────────────
// Converts strike data from Upstox option chain into exact Kite trading symbol.
//
// Confirmed format from Zerodha trade book:
//   NIFTY   → NSE/NFO  →  NIFTY  + YY + M (no leading zero) + DD + STRIKE + CE/PE
//   SENSEX  → BSE/BFO  →  SENSEX + YY + M (no leading zero) + DD + STRIKE + CE/PE
//
// Examples from trade book:
//   NIFTY2610626750CE   = NIFTY + 26 + 1 + 06 + 26750 + CE  (expiry 2026-01-06)
//   SENSEX2610185000PE  = SENSEX + 26 + 1 + 01 + 85000 + PE (expiry 2026-01-01)
//
// Key rules:
//   - Year  : 2 digits          (2026 → 26)
//   - Month : no leading zero   (January → 1, October → 10)
//   - Day   : 2 digits always   (6th → 06, 15th → 15)
//   - Strike: as-is number      (26750, 85000)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build exact Kite trading symbol from strike data.
 *
 * @param {string} index     - "NIFTY" | "SENSEX"
 * @param {string} expiry    - "YYYY-MM-DD" from Upstox option chain
 * @param {number} strike    - strike price number e.g. 24750
 * @param {string} optType   - "CE" | "PE"
 * @returns {string}         - e.g. "NIFTY2610626750CE"
 *
 * ✅ FIX: Added padStart(2,'0') on day.
 *         Upstox option chain expiry can return "2026-1-6" (no padding) in some
 *         API versions. Without padding, symbol becomes "NIFTY261626750CE" which
 *         is wrong — Kite requires 2-digit day always ("06" not "6").
 */
export const buildKiteSymbol = (index, expiry, strike, optType) => {
  const [yyyy, mm, dd] = expiry.split("-");

  const yy    = yyyy.slice(2);              // "2026" → "26"
  const month = String(parseInt(mm));       // "01" → "1", "10" → "10" (no leading zero)
  const day   = dd.padStart(2, '0');        // ✅ FIX: "6" → "06", "15" stays "15"

  return `${index}${yy}${month}${day}${strike}${optType}`;
};

/**
 * Get Kite exchange for index.
 * NIFTY  → NFO (NSE F&O)
 * SENSEX → BFO (BSE F&O)
 */
export const getKiteExchange = (index) => {
  return index === "SENSEX" ? "BFO" : "NFO";
};