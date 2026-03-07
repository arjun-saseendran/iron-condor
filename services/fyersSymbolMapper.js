/**
 * Utility to translate between Fyers and Zerodha (Kite) symbols.
 * Fyers weekly option format: NSE:NIFTY{YY}{M}{DD}{STRIKE}{CE/PE}
 * M = single digit for Jan-Sep (1-9), then O=Oct, N=Nov, D=Dec
 */

// Month code map for Fyers weekly options
const FYERS_MONTH_CODE = {
  1: '1', 2: '2', 3: '3', 4: '4', 5: '5',
  6: '6', 7: '7', 8: '8', 9: '9',
  10: 'O', 11: 'N', 12: 'D'
};

/**
 * Get next weekly expiry date
 * NIFTY expires every Tuesday (day=2)
 * SENSEX expires every Thursday (day=4)
 */
export const getNextWeeklyExpiry = (index = 'NIFTY') => {
  const targetDay = (index === 'SENSEX' || index === 'BANKEX') ? 4 : 2; // Thu=4, Tue=2
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  
  const day = ist.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  let daysUntilExpiry = (targetDay - day + 7) % 7;
  
  // If today is expiry day, use today (market hours) else next occurrence
  if (daysUntilExpiry === 0) daysUntilExpiry = 0;
  
  const expiry = new Date(ist);
  expiry.setDate(ist.getDate() + daysUntilExpiry);
  
  return expiry;
};

/**
 * Build Fyers option symbol
 * Format: NSE:NIFTY{YY}{M}{DD}{STRIKE}{CE/PE}
 * Example: NSE:NIFTY2631022500CE (26=year, 3=March, 10=day, 22500=strike)
 */
export const buildFyersOptionSymbol = (index, strike, type) => {
  const expiry = getNextWeeklyExpiry(index);
  
  const yy = String(expiry.getFullYear()).slice(-2);         // "26"
  const m  = FYERS_MONTH_CODE[expiry.getMonth() + 1];       // "3" for March
  const dd = String(expiry.getDate()).padStart(2, '0');      // "04"
  const prefix = (index === 'SENSEX' || index === 'BANKEX') ? 'BSE' : 'NSE';
  
  return `${prefix}:${index}${yy}${m}${dd}${strike}${type}`;
};

// ✅ KEPT FOR BACKWARD COMPATIBILITY — used by ironCondorEngine and other services
export const kiteToFyersSymbol = (kiteSymbol, index = 'NIFTY') => {
  if (!kiteSymbol) return null;
  const prefix = (index === 'SENSEX' || index === 'BANKEX') ? 'BSE' : 'NSE';
  return `${prefix}:${kiteSymbol}`;
};

// Converts Fyers symbol back to Kite (strips the exchange prefix)
export const fyersToKiteSymbol = (fyersSymbol) => {
  if (!fyersSymbol) return null;
  const parts = fyersSymbol.split(':');
  return parts.length > 1 ? parts[1] : parts[0];
};

// Returns the Fyers Index spot symbol
export const getFyersIndexSymbol = (index) => {
  if (index === 'SENSEX') return 'BSE:SENSEX-INDEX';
  if (index === 'BANKEX') return 'BSE:BANKEX-INDEX';
  return 'NSE:NIFTY50-INDEX';
};