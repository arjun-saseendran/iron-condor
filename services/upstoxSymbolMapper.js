/**
 * Utility to translate between Zerodha (Kite) and Upstox symbols.
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️  BUG FIX (was causing order failures):
 *
 *   OLD regex: /^([A-Z]+)(\d{2})(\d{1,2})(\d{2})(\d+)(CE|PE)$/
 *   Problem:   \d{1,2} is GREEDY — it consumed TWO digits as "month"
 *              NIFTY2531022500CE was parsed as: yy=25, month=31, day=02, strike=2500
 *              UPSTOX_MONTH_NAME[31] = undefined → returns null → ORDER FAILS
 *
 *   ROOT CAUSE: Kite (and Fyers) weekly option month code is ALWAYS 1 character:
 *              digits 1–9 for Jan–Sep, letters O/N/D for Oct/Nov/Dec
 *              The regex must use exactly 1 char: [1-9OND]
 *
 *   CORRECT:   NIFTY2531022500CE → yy=25, month='3'=MAR, day=10, strike=22500
 *              → NSE_FO|NIFTY10MAR202522500CE  ✓
 * ════════════════════════════════════════════════════════════════
 *
 * Kite weekly format:  NIFTY2531022500CE   (YY + M_char + DD + STRIKE + TYPE)
 * Kite monthly format: NIFTY25MAR22500CE   (YY + MON_3char + STRIKE + TYPE)
 * Upstox format:       NSE_FO|NIFTY10MAR202522500CE (DD + MON_3char + YYYY)
 *
 * For index spot:
 *   NSE_INDEX|Nifty 50
 *   BSE_INDEX|SENSEX
 */

// Kite/Fyers single-char month code → Upstox 3-char month name
const KITE_MONTH_TO_UPSTOX = {
  '1': 'JAN', '2': 'FEB', '3': 'MAR', '4': 'APR',
  '5': 'MAY', '6': 'JUN', '7': 'JUL', '8': 'AUG',
  '9': 'SEP', 'O': 'OCT', 'N': 'NOV', 'D': 'DEC',
};

/**
 * Get next weekly expiry date
 * NIFTY  → Tuesday  (day=2)
 * SENSEX → Thursday (day=4)
 */
export const getNextWeeklyExpiry = (index = 'NIFTY') => {
  const targetDay = (index === 'SENSEX' || index === 'BANKEX') ? 4 : 2;
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const day = ist.getDay();
  const daysUntilExpiry = (targetDay - day + 7) % 7;

  const expiry = new Date(ist);
  expiry.setDate(ist.getDate() + daysUntilExpiry);
  return expiry;
};

/**
 * Build Upstox option instrument key from scratch (index + strike + CE/PE).
 * Uses the next weekly expiry automatically.
 *
 * Output: NSE_FO|NIFTY10MAR202522500CE
 */
export const buildUpstoxOptionSymbol = (index, strike, type) => {
  const expiry = getNextWeeklyExpiry(index);

  const dd   = String(expiry.getDate()).padStart(2, '0');
  const mon  = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][expiry.getMonth()];
  const yyyy = expiry.getFullYear();
  const exchange = (index === 'SENSEX' || index === 'BANKEX') ? 'BSE_FO' : 'NSE_FO';

  return `${exchange}|${index}${dd}${mon}${yyyy}${strike}${type}`;
};

/**
 * Convert Kite option symbol to Upstox instrument key.
 *
 * Handles both weekly and monthly Kite formats:
 *
 *   Weekly:  NIFTY2531022500CE  → NSE_FO|NIFTY10MAR202522500CE
 *   Monthly: NIFTY25MAR22500CE  → NSE_FO|NIFTYMAR202522500CE
 *
 * ⚠️  The month code in Kite weekly symbols is ALWAYS 1 character:
 *     1–9 for Jan–Sep, O=Oct, N=Nov, D=Dec
 *     The regex enforces this with [1-9OND] (exactly 1 char).
 */
export const kiteToUpstoxSymbol = (kiteSymbol, index = 'NIFTY') => {
  if (!kiteSymbol) return null;

  const exchange = (index === 'SENSEX' || index === 'BANKEX') ? 'BSE_FO' : 'NSE_FO';

  // ── Monthly format: NIFTY25MAR22500CE ───────────────────────────────────
  const monthlyMatch = kiteSymbol.match(
    /^([A-Z]+)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+)(CE|PE)$/i
  );
  if (monthlyMatch) {
    const [, name, yy, mon, strike, type] = monthlyMatch;
    const yyyy = `20${yy}`;
    return `${exchange}|${name.toUpperCase()}${mon.toUpperCase()}${yyyy}${strike}${type.toUpperCase()}`;
  }

  // ── Weekly format: NIFTY2531022500CE ────────────────────────────────────
  // Format:  {NAME}{YY}{M_1char}{DD_2chars}{STRIKE}{TYPE}
  // M is exactly 1 character: digit 1-9 or letter O/N/D
  // FIXED: was (\d{1,2})(\d{2}) which greedily consumed 2 digits as "month"
  const weeklyMatch = kiteSymbol.match(
    /^([A-Z]+)(\d{2})([1-9ONDond])(\d{2})(\d+)(CE|PE)$/i
  );
  if (weeklyMatch) {
    const [, name, yy, m, dd, strike, type] = weeklyMatch;
    const mon = KITE_MONTH_TO_UPSTOX[m.toUpperCase()];
    if (!mon) {
      console.error(`❌ kiteToUpstoxSymbol: unknown month code '${m}' in symbol '${kiteSymbol}'`);
      return null;
    }
    const yyyy = `20${yy}`;
    const ddPadded = dd.padStart(2, '0');
    return `${exchange}|${name.toUpperCase()}${ddPadded}${mon}${yyyy}${strike}${type.toUpperCase()}`;
  }

  // Fallback: already-formatted or unrecognised — just prefix exchange
  console.warn(`⚠️ kiteToUpstoxSymbol: could not parse '${kiteSymbol}', using fallback`);
  return `${exchange}|${kiteSymbol}`;
};

/**
 * Convert Upstox instrument key back to Kite-style symbol (strips exchange prefix).
 * NSE_FO|NIFTY10MAR202522500CE → NIFTY10MAR202522500CE
 */
export const upstoxToKiteSymbol = (upstoxKey) => {
  if (!upstoxKey) return null;
  const parts = upstoxKey.split('|');
  return parts.length > 1 ? parts[1] : parts[0];
};

/**
 * Returns the Upstox index spot instrument key.
 */
export const getUpstoxIndexSymbol = (index) => {
  if (index === 'SENSEX')    return 'BSE_INDEX|SENSEX';
  if (index === 'BANKEX')    return 'BSE_INDEX|BANKEX';
  if (index === 'BANKNIFTY') return 'NSE_INDEX|Nifty Bank';
  return 'NSE_INDEX|Nifty 50';
};

/**
 * Build Upstox instrument key for equity (requires ISIN).
 */
export const buildUpstoxEquityKey = (exchange, isin) => {
  const ex = exchange?.toUpperCase() === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
  return `${ex}|${isin}`;
};