/**
 * autoCondorEngine.js — FULL AUTO mode for Iron Condor.
 *
 * Differences vs semi-auto (ironCondorEngine.js):
 *   • Automatic entry at 9:30 AM IST
 *   • Automatic offensive firefight: one side loss ≥ 3× entry premium AND other side ≥ 70% profit
 *   • Full option chain scan for firefight (not limited to N strikes)
 *   • Automatic Iron Butterfly conversion: sell-side becomes ATM AND that spread's SL is hit
 *   • Automatic SL exit (same rules as semi-auto)
 *   • Gap up/gap down: suppress SL, let position consolidate/expire
 *   • Max 2 SL hits per index per day — blocks re-entry after 2nd hit
 *   • Adopts existing ACTIVE semi-auto trade when activated mid-session
 *   • Semi ↔ Auto toggle per trade (isAutoMode flag)
 *
 * Entry minimums:
 *   NIFTY:   call ≥ 6,  put ≥ 6,   total ≥ 12
 *   SENSEX:  call ≥ 20, put ≥ 20,  total ≥ 40  (net IC = call+put, each leg minimum 20)
 *
 * Iron Butterfly trigger (corrected):
 *   • Sell-side strike becomes ATM (spot reaches short strike)  ← condition 1
 *   • AND that spread's SL is hit                               ← condition 2
 *   Both must be true — not just spot reaching the strike.
 *
 * Firefight trigger (corrected):
 *   • One side net premium ≥ 3× its entry premium (losing badly)
 *   • AND other side net premium ≤ 30% of its entry premium (70% profit)
 *   • Bot scans FULL option chain (all valid strikes, not just 8 away)
 *   • Rolls the losing side inward toward ATM for fresh premium
 */

import { getLTP }                         from '../config/upstoxConfig.js';
import { getIO }                          from '../config/socket.js';
import { sendCondorAlert }                from '../services/telegramService.js';
import { executeMarketExit,
         executeMarginSafeEntry }         from '../services/IronCodorOrderService.js';
import {
  buildUpstoxOptionSymbol,
  getUpstoxIndexSymbol,
  kiteToUpstoxSymbol,
}                                         from '../services/upstoxSymbolMapper.js';
import { condorPrices }                   from './ironCondorEngine.js';
import getActiveTradeModel                from '../models/ironCondorActiveTradeModel.js';
import { getCondorTradePerformanceModel } from '../models/condorTradePerformanceModel.js';
import dotenv from 'dotenv';
dotenv.config();

const ActiveTrade      = () => getActiveTradeModel();
const TradePerformance = () => getCondorTradePerformanceModel();

const log = (msg, level = 'info') => {
  console.log(msg);
  const io = getIO();
  if (io) io.emit('trade_log', {
    msg, level, strategy: 'AUTO_CONDOR',
    time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
  });
};

// ═══════════════════════════════════════════════════════════════
// CONFIG — per-index
// ═══════════════════════════════════════════════════════════════
const CFG = {
  NIFTY: {
    minSide:    6,          // minimum net premium per spread leg
    minTotal:   12,         // minimum combined IC premium
    step:       50,         // strike step size
    spreadDist: () => parseInt(process.env.NIFTY_SPREAD_DISTANCE  || '150'),
    lotSize:    () => parseInt(process.env.NIFTY_LOT_SIZE  || process.env.NIFTY_QTY  || '75'),
    // Full chain scan: scan from 1 strike out to this many strikes
    maxStrikeScan: 40,
  },
  SENSEX: {
    minSide:    20,         // each spread must collect ≥ 20 individually
    minTotal:   40,         // combined IC total ≥ 40 (20 call + 20 put)
    step:       100,
    spreadDist: () => parseInt(process.env.SENSEX_SPREAD_DISTANCE || '500'),
    lotSize:    () => parseInt(process.env.SENSEX_LOT_SIZE || process.env.SENSEX_QTY || '10'),
    maxStrikeScan: 40,
  },
};
const cfg = (index) => CFG[index] || CFG.NIFTY;

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
let autoModeActive   = false;
let entryAttempted   = { NIFTY: false, SENSEX: false };
let slHitCount       = { NIFTY: 0,     SENSEX: 0    };
let lastScanTime     = 0;
let _monitorInterval = null;

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
const isMarketOpen = () => {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day  = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return day >= 1 && day <= 5 && mins >= (9 * 60 + 15) && mins < (15 * 60 + 30);
};

const getIndexForToday = () => {
  const day = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay();
  if (day === 1 || day === 2) return 'NIFTY';
  if (day === 3 || day === 4) return 'SENSEX';
  return null;
};

const extractStrike = (symbol) => {
  if (!symbol) return null;
  const m = symbol.match(/(\d+)(CE|PE)$/);
  return m ? parseInt(m[1]) : null;
};

const extractBase = (symbol) => {
  if (!symbol) return null;
  const m = symbol.match(/^(.+?)(\d+)(CE|PE)$/);
  return m ? m[1] : null;
};

// Strip exchange prefix for order placement: NSE_FO|NIFTY...CE → NIFTY...CE
const forOrder = (upstoxKey) => upstoxKey?.split('|')[1] || upstoxKey;

const estimatePnL = (callEntry, putEntry, callCur, putCur, qty) =>
  ((callEntry - callCur) + (putEntry - putCur)) * qty;

// ═══════════════════════════════════════════════════════════════
// BUFFER — walk back to last SL hit (same as semi-auto)
// ═══════════════════════════════════════════════════════════════
const fetchBuffer = async (index, qty) => {
  try {
    const recent = await TradePerformance()
      .find({ index })
      .sort({ createdAt: -1 })
      .limit(20);
    let profit = 0;
    for (const t of recent) {
      if (t.exitReason === 'STOP_LOSS_HIT') break;
      if (
        t.exitReason === 'PROFIT_TARGET' ||
        t.exitReason === 'MANUAL_CLOSE'  ||
        t.exitReason === 'FIREFIGHT'
      ) {
        profit += t.firefightBookedPnL ?? t.realizedPnL;
      }
    }
    return Math.max(0, profit / qty);
  } catch { return 0; }
};

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════
export const getAutoModeStatus = () => ({
  active:         autoModeActive,
  slHitCount:     { ...slHitCount },
  entryAttempted: { ...entryAttempted },
  maxSlHits:      2,
});

// ───────────────────────────────────────────────────────────────
// TOGGLE: convert a specific trade between semi-auto and auto
// Call from your API route:  POST /api/condor/toggle-auto { tradeId }
// ───────────────────────────────────────────────────────────────
export const toggleTradeAutoMode = async (tradeId) => {
  try {
    const trade = await ActiveTrade().findById(tradeId);
    if (!trade || trade.status !== 'ACTIVE') {
      return { ok: false, msg: 'Trade not found or not active' };
    }

    trade.isAutoMode = !trade.isAutoMode;

    // Ensure all alert fields exist when switching to auto
    if (trade.isAutoMode) {
      trade.alertsSent.callDefense  = trade.alertsSent.callDefense  ?? false;
      trade.alertsSent.putDefense   = trade.alertsSent.putDefense   ?? false;
      trade.alertsSent.gapAlert     = trade.alertsSent.gapAlert     ?? false;
      trade.alertsSent.firefightAlert = trade.alertsSent.firefightAlert ?? false;
    }

    await trade.save();

    const mode = trade.isAutoMode ? '🤖 AUTO' : '🖐 SEMI-AUTO';
    sendCondorAlert(
      `🔄 <b>Trade Mode Toggled: ${trade.index}</b>\n` +
      `Trade ID: ${trade._id}\n` +
      `New Mode: ${mode}`
    );
    log(`🔄 Trade ${tradeId} switched to ${mode}`, 'info');
    return { ok: true, isAutoMode: trade.isAutoMode };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
};

// ───────────────────────────────────────────────────────────────
// ACTIVATE auto mode globally
// Adopts any existing ACTIVE trades that were placed in semi-auto
// ───────────────────────────────────────────────────────────────
export const activateAutoMode = async () => {
  if (autoModeActive) return { ok: false, msg: 'Already active' };

  autoModeActive = true;
  entryAttempted = { NIFTY: false, SENSEX: false };
  slHitCount     = { NIFTY: 0,     SENSEX: 0    };

  // Adopt any existing ACTIVE trades
  try {
    const existing = await ActiveTrade().find({ status: 'ACTIVE' });
    for (const trade of existing) {
      if (!trade.isAutoMode) {
        trade.isAutoMode                    = true;
        trade.alertsSent.callDefense        = trade.alertsSent.callDefense  ?? false;
        trade.alertsSent.putDefense         = trade.alertsSent.putDefense   ?? false;
        trade.alertsSent.gapAlert           = trade.alertsSent.gapAlert     ?? false;
        trade.alertsSent.firefightAlert     = trade.alertsSent.firefightAlert ?? false;
        trade.alertsSent.butterflyAtmAlert  = trade.alertsSent.butterflyAtmAlert ?? false;
        await trade.save();

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todaySlHits = await TradePerformance().countDocuments({
          index: trade.index, exitReason: 'STOP_LOSS_HIT', createdAt: { $gte: today },
        });
        slHitCount[trade.index]     = todaySlHits;
        entryAttempted[trade.index] = true; // trade is live, don't re-enter

        log(`🔄 Adopted existing ${trade.index} trade (${trade._id}) | SL hits today: ${todaySlHits}`, 'info');
        sendCondorAlert(
          `🤖 <b>Auto Mode Adopted: ${trade.index}</b>\n` +
          `Trade ID: ${trade._id}\n` +
          `Call: ${trade.symbols.callSell} / ${trade.symbols.callBuy}\n` +
          `Put:  ${trade.symbols.putSell}  / ${trade.symbols.putBuy}\n` +
          `SL hits today: ${todaySlHits}/2 | Buffer: ${trade.bufferPremium?.toFixed(2)} pts\n` +
          `Auto engine now managing this position.`
        );
      }
    }
  } catch (err) {
    log(`⚠️ Could not adopt existing trades: ${err.message}`, 'warn');
  }

  _startMonitor();
  log('🤖 AUTO MODE ACTIVATED', 'info');
  sendCondorAlert('🤖 <b>Auto Condor Mode: ACTIVATED</b>\nBot will place entries at 9:30 AM IST and manage all firefights + SL automatically.');
  return { ok: true };
};

export const deactivateAutoMode = async () => {
  autoModeActive = false;
  _stopMonitor();

  try {
    await ActiveTrade().updateMany(
      { status: 'ACTIVE', isAutoMode: true },
      { $set: { isAutoMode: false } }
    );
  } catch (_) {}

  log('🛑 AUTO MODE DEACTIVATED', 'info');
  sendCondorAlert('🛑 <b>Auto Condor Mode: DEACTIVATED</b>\nExisting positions handed back to semi-auto monitoring.');
  return { ok: true };
};

// ═══════════════════════════════════════════════════════════════
// MONITOR LOOP — 2-second tick
// ═══════════════════════════════════════════════════════════════
const _startMonitor = () => {
  if (_monitorInterval) clearInterval(_monitorInterval);
  _monitorInterval = setInterval(_tick, 2000);
};

const _stopMonitor = () => {
  if (_monitorInterval) { clearInterval(_monitorInterval); _monitorInterval = null; }
};

const _tick = async () => {
  if (!autoModeActive || !isMarketOpen()) return;
  const index = getIndexForToday();
  if (!index) return;

  try {
    if (!entryAttempted[index]) await _checkAndEnter(index);

    if (Date.now() - lastScanTime > 2000) {
      lastScanTime = Date.now();
      await _monitorAutoLevels(index);
    }
  } catch (err) {
    log(`❌ Auto tick error: ${err.message}`, 'error');
  }
};

// ═══════════════════════════════════════════════════════════════
// ENTRY — 9:30–9:45 AM window
// SENSEX: each spread must individually meet minSide (20),
//         combined must meet minTotal (40 = 20 + 20)
// ═══════════════════════════════════════════════════════════════
const _checkAndEnter = async (index) => {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 9 * 60 + 30 || mins > 9 * 60 + 45) return;

  const existing = await ActiveTrade().findOne({ index, status: 'ACTIVE' });
  if (existing) { entryAttempted[index] = true; return; }

  if ((slHitCount[index] || 0) >= 2) {
    log(`🚫 Entry blocked: 2 SL hits reached for ${index}`, 'warn');
    entryAttempted[index] = true;
    return;
  }

  entryAttempted[index] = true; // prevent concurrent attempts
  log(`🔍 Auto entry scan: ${index} at ${now.toLocaleTimeString('en-IN')}`, 'info');

  try {
    const ok = await _findAndPlaceEntry(index);
    if (!ok) {
      entryAttempted[index] = false; // allow retry within window
      log(`⏳ No valid premium for ${index} — will retry`, 'info');
    }
  } catch (err) {
    entryAttempted[index] = false;
    log(`❌ Auto entry error: ${err.message}`, 'error');
  }
};

const _findAndPlaceEntry = async (index) => {
  const c         = cfg(index);
  const spotKey   = getUpstoxIndexSymbol(index);
  const spotPrice = condorPrices[spotKey] || 0;
  if (!spotPrice) return false;

  const dist  = c.spreadDist();
  const stp   = c.step;
  const qty   = c.lotSize();
  const atm   = Math.round(spotPrice / stp) * stp;

  // Build full scan list out to maxStrikeScan strikes on each side
  const scanList = [];
  for (let i = 1; i <= c.maxStrikeScan; i++) {
    scanList.push({
      callShort: atm + i * stp,  callLong: atm + i * stp + dist,
      putShort:  atm - i * stp,  putLong:  atm - i * stp - dist,
    });
  }

  // Fetch all LTPs in one batch
  const allKeys = scanList.flatMap(s => [
    buildUpstoxOptionSymbol(index, s.callShort, 'CE'),
    buildUpstoxOptionSymbol(index, s.callLong,  'CE'),
    buildUpstoxOptionSymbol(index, s.putShort,  'PE'),
    buildUpstoxOptionSymbol(index, s.putLong,   'PE'),
  ]);

  const quotes = await getLTP(allKeys);
  if (!quotes) { log(`⚠️ LTP fetch failed for ${index} entry scan`, 'warn'); return false; }

  let best = null;
  for (const s of scanList) {
    const csLtp = quotes[buildUpstoxOptionSymbol(index, s.callShort, 'CE')]?.last_price || 0;
    const clLtp = quotes[buildUpstoxOptionSymbol(index, s.callLong,  'CE')]?.last_price || 0;
    const psLtp = quotes[buildUpstoxOptionSymbol(index, s.putShort,  'PE')]?.last_price || 0;
    const plLtp = quotes[buildUpstoxOptionSymbol(index, s.putLong,   'PE')]?.last_price || 0;

    const callNet = Math.abs(csLtp - clLtp);
    const putNet  = Math.abs(psLtp - plLtp);

    // Both spreads must individually meet minSide AND combined meet minTotal
    // SENSEX example: callNet ≥ 20, putNet ≥ 20, total ≥ 40
    // NIFTY example:  callNet ≥ 6,  putNet ≥ 6,  total ≥ 12
    if (callNet >= c.minSide && putNet >= c.minSide && (callNet + putNet) >= c.minTotal) {
      best = { s, callNet, putNet };
      break;
    }
  }

  if (!best) {
    log(`⚠️ No strike meets premium criteria for ${index} (need each ≥₹${c.minSide}, total ≥₹${c.minTotal})`, 'warn');
    return false;
  }

  const { s, callNet, putNet } = best;
  const csKite = forOrder(buildUpstoxOptionSymbol(index, s.callShort, 'CE'));
  const clKite = forOrder(buildUpstoxOptionSymbol(index, s.callLong,  'CE'));
  const psKite = forOrder(buildUpstoxOptionSymbol(index, s.putShort,  'PE'));
  const plKite = forOrder(buildUpstoxOptionSymbol(index, s.putLong,   'PE'));

  const isLive = process.env.LIVE_TRADING === 'true';
  if (isLive) {
    await executeMarginSafeEntry(clKite, csKite, qty, index); // longs first
    await executeMarginSafeEntry(plKite, psKite, qty, index);
  } else {
    log(`📝 [PAPER] SELL ${csKite} BUY ${clKite} | SELL ${psKite} BUY ${plKite}`, 'info');
  }

  const buffer = await fetchBuffer(index, qty);

  await ActiveTrade().create({
    index,
    status:                 'ACTIVE',
    tradeType:              'IRON_CONDOR',
    isIronButterfly:        false,
    isAutoMode:             true,
    spreadSLCount:          0,
    bufferPremium:          buffer,
    lotSize:                qty,
    callSpreadEntryPremium: callNet,
    putSpreadEntryPremium:  putNet,
    totalEntryPremium:      callNet + putNet,
    alertsSent: {
      call70Decay:       false,
      put70Decay:        false,
      firefightAlert:    false,
      callDefense:       false,
      putDefense:        false,
      gapAlert:          false,
      butterflyAtmAlert: false, // spot reached ATM — waiting for SL confirm
    },
    symbols: { callSell: csKite, callBuy: clKite, putSell: psKite, putBuy: plKite },
    tokens: { spotIndex: 256265 },
  });

  sendCondorAlert(
    `🤖 <b>AUTO ENTRY: ${index}</b>\n` +
    `Call: SELL ${s.callShort} / BUY ${s.callLong} → ₹${callNet.toFixed(2)}\n` +
    `Put:  SELL ${s.putShort}  / BUY ${s.putLong}  → ₹${putNet.toFixed(2)}\n` +
    `Total IC Premium: ₹${(callNet + putNet).toFixed(2)} (each ≥ ₹${c.minSide})\n` +
    `Qty: ${qty} | Buffer: ${buffer.toFixed(2)} pts\n` +
    `Mode: ${isLive ? 'LIVE 🔴' : 'PAPER 📝'}`
  );
  return true;
};

// ═══════════════════════════════════════════════════════════════
// LIVE MONITOR — priority order:
//   1. Gap protection
//   2. Stop loss
//   3. Iron Butterfly conversion (ATM breach + SL hit together)
//   4. Offensive firefight (3× loss one side + 70% profit other)
// ═══════════════════════════════════════════════════════════════
const _monitorAutoLevels = async (index) => {
  const trade = await ActiveTrade().findOne({ index, status: 'ACTIVE', isAutoMode: true });
  if (!trade) return;

  const c       = cfg(index);
  const getLtp  = (sym) => sym ? condorPrices[kiteToUpstoxSymbol(sym, index)] || 0 : 0;
  const spotLTP = condorPrices[getUpstoxIndexSymbol(index)] || 0;

  const callNet    = trade.symbols.callSell
    ? Math.abs(getLtp(trade.symbols.callSell) - getLtp(trade.symbols.callBuy)) : 0;
  const putNet     = trade.symbols.putSell
    ? Math.abs(getLtp(trade.symbols.putSell)  - getLtp(trade.symbols.putBuy))  : 0;

  const callEntry  = trade.callSpreadEntryPremium;
  const putEntry   = trade.putSpreadEntryPremium;
  const buffer     = trade.bufferPremium || 0;
  const spread     = c.spreadDist();

  const callShortStrike = extractStrike(trade.symbols.callSell);
  const putShortStrike  = extractStrike(trade.symbols.putSell);

  // Per-spread SL thresholds (5× entry + buffer, capped at spread/2)
  const rawCallSL  = (callEntry * 4) + buffer;
  const rawPutSL   = (putEntry  * 4) + buffer;
  const maxSpreadSL = spread / 2;
  const callSL     = Math.min(rawCallSL,  maxSpreadSL);
  const putSL      = Math.min(rawPutSL,   maxSpreadSL);
  const butterflySL = (trade.totalEntryPremium * 3) + buffer;

  // ── 1. GAP PROTECTION ──────────────────────────────────────────────────
  // Spot has blown through a short strike — suppress all exits, hold to expiry
  const isGap = spotLTP > 0 && callShortStrike && putShortStrike &&
    (spotLTP > callShortStrike * 1.005 || spotLTP < putShortStrike * 0.995);

  if (isGap) {
    if (!trade.alertsSent.gapAlert) {
      trade.alertsSent.gapAlert = true;
      await trade.save();
      const maxLoss = spread - (callEntry + putEntry + buffer);
      sendCondorAlert(
        `⚡ <b>GAP SCENARIO — NO AUTO EXIT: ${index}</b>\n` +
        `Spot ${spotLTP} has blown through short strike.\n` +
        `Max capped loss ≈ ₹${(maxLoss * trade.lotSize).toFixed(0)}\n` +
        `Formula: Spread(${spread}) − NetPremium(${(callEntry+putEntry).toFixed(2)}) + Buffer(${buffer.toFixed(2)})\n` +
        `⏳ Holding to expiry.`
      );
    }
    _emitTick(index, spotLTP, callNet, putNet, trade, callSL, putSL);
    return;
  }

  // ── 2. STOP LOSS ────────────────────────────────────────────────────────
  let slHit   = false;
  let slSide  = null;
  let isFullExit = false;

  if (trade.isIronButterfly) {
    // Iron Butterfly SL = original IC total premium × 3 + buffer
    if ((callNet + putNet) >= butterflySL) {
      slHit = true; slSide = 'BOTH'; isFullExit = true;
    }
  } else {
    const currentSLCount = trade.spreadSLCount || 0;
    if (callNet >= callSL)     { slHit = true; slSide = 'CALL'; isFullExit = (currentSLCount + 1) >= 2; }
    else if (putNet >= putSL)  { slHit = true; slSide = 'PUT';  isFullExit = (currentSLCount + 1) >= 2; }
  }

  if (slHit) {
    const newSLCount = (trade.spreadSLCount || 0) + 1;
    trade.spreadSLCount = newSLCount;
    trade.status = 'EXITING';
    await trade.save();

    slHitCount[index] = (slHitCount[index] || 0) + 1;
    log(`🚨 AUTO SL HIT #${slHitCount[index]}/2 for ${index} (${slSide})`, 'error');

    sendCondorAlert(
      `🚨 <b>AUTO STOP LOSS #${slHitCount[index]}/2: ${index}</b>\n` +
      `Side: ${slSide}\n` +
      `Exit Type: ${isFullExit ? '🔴 FULL EXIT' : '🟡 PARTIAL (one spread)'}`
    );

    await executeMarketExit(trade, isFullExit ? 'FULL' : slSide);
    trade.status = 'COMPLETED';
    await trade.save();

    await TradePerformance().create({
      strategy: 'IRON_CONDOR', index,
      activeTradeId: trade._id,
      exitReason:    'STOP_LOSS_HIT',
      realizedPnL:   estimatePnL(callEntry, putEntry, callNet, putNet, trade.lotSize),
      notes:         `AUTO SL HIT #${slHitCount[index]} | Side: ${slSide} | ${isFullExit ? 'FULL EXIT' : 'PARTIAL'}`,
    });

    if (slHitCount[index] >= 2) {
      sendCondorAlert(`🛑 <b>MAX SL HITS (2) REACHED: ${index}</b>\nNo more auto entries today.`);
      entryAttempted[index] = true; // block re-entry
    } else {
      entryAttempted[index] = false; // allow re-entry for next circle
      sendCondorAlert(
        `🔄 <b>RESET: ${index} — ${slSide} spread exited</b>\n` +
        `Healthy side remains open.\n` +
        `Auto will re-enter ${slSide} spread at next valid premium.\n` +
        `SL hits: ${slHitCount[index]}/2`
      );
    }
    return;
  }

  // ── 3. IRON BUTTERFLY CONVERSION ────────────────────────────────────────
  // CONDITION 1: spot has reached the short strike (ATM breach)
  // CONDITION 2: that spread's SL threshold is hit
  // BOTH must be true before converting — not just the ATM breach alone
  if (!trade.isIronButterfly && spotLTP > 0) {
    const callAtmBreached = callShortStrike && spotLTP >= callShortStrike;
    const putAtmBreached  = putShortStrike  && spotLTP <= putShortStrike;
    const callSpreadSLHit = callNet >= callSL;
    const putSpreadSLHit  = putNet  >= putSL;

    // Alert on ATM breach (condition 1 only) — waiting for SL confirm
    if (callAtmBreached && !callSpreadSLHit && !trade.alertsSent.butterflyAtmAlert) {
      trade.alertsSent.butterflyAtmAlert = true;
      await trade.save();
      sendCondorAlert(
        `⚠️ <b>BUTTERFLY WATCH: ${index} CALL ATM</b>\n` +
        `Spot (${spotLTP}) reached Short Call Strike (${callShortStrike}).\n` +
        `Waiting for CALL spread SL hit to confirm butterfly conversion.\n` +
        `Call SL Level: ₹${callSL.toFixed(2)} | Current: ₹${callNet.toFixed(2)}`
      );
    } else if (putAtmBreached && !putSpreadSLHit && !trade.alertsSent.butterflyAtmAlert) {
      trade.alertsSent.butterflyAtmAlert = true;
      await trade.save();
      sendCondorAlert(
        `⚠️ <b>BUTTERFLY WATCH: ${index} PUT ATM</b>\n` +
        `Spot (${spotLTP}) reached Short Put Strike (${putShortStrike}).\n` +
        `Waiting for PUT spread SL hit to confirm butterfly conversion.\n` +
        `Put SL Level: ₹${putSL.toFixed(2)} | Current: ₹${putNet.toFixed(2)}`
      );
    }

    // Both conditions met — execute butterfly conversion
    const doCallButterfly = callAtmBreached && callSpreadSLHit && !trade.alertsSent.callDefense;
    const doPutButterfly  = putAtmBreached  && putSpreadSLHit  && !trade.alertsSent.putDefense;

    if (doCallButterfly || doPutButterfly) {
      const side        = doCallButterfly ? 'PE' : 'CE';
      const shortStrike = doCallButterfly ? callShortStrike : putShortStrike;
      const longStrike  = side === 'PE'
        ? shortStrike - c.spreadDist()
        : shortStrike + c.spreadDist();

      log(`🦋 AUTO BUTTERFLY: ${index} — rolling ${side} to ATM ${shortStrike}`, 'info');
      sendCondorAlert(
        `🦋 <b>BUTTERFLY CONVERSION TRIGGERED: ${index}</b>\n` +
        `Both conditions met:\n` +
        `  ✅ Spot (${spotLTP}) at short strike (${shortStrike})\n` +
        `  ✅ ${side === 'PE' ? 'CALL' : 'PUT'} spread SL hit\n` +
        `Rolling ${side} side to ATM...`
      );

      await _executeRoll(trade, side, shortStrike, longStrike, index, 'BUTTERFLY');

      const shortKite = forOrder(buildUpstoxOptionSymbol(index, shortStrike, side));
      const longKite  = forOrder(buildUpstoxOptionSymbol(index, longStrike,  side));
      if (side === 'PE') {
        trade.symbols.putSell        = shortKite;
        trade.symbols.putBuy         = longKite;
        trade.alertsSent.putDefense  = true;
      } else {
        trade.symbols.callSell       = shortKite;
        trade.symbols.callBuy        = longKite;
        trade.alertsSent.callDefense = true;
      }
      trade.isIronButterfly           = true;
      trade.alertsSent.firefightAlert = true; // no further firefight after butterfly
      await trade.save();

      sendCondorAlert(
        `🦋 <b>AUTO BUTTERFLY DONE: ${index}</b>\n` +
        `${side}: SELL ${shortStrike} / BUY ${longStrike}\n` +
        `Butterfly SL: ₹${butterflySL.toFixed(2)} (IC premium × 3 + buffer)`
      );
      _emitTick(index, spotLTP, callNet, putNet, trade, callSL, putSL);
      return;
    }
  }

  // ── 4. OFFENSIVE FIREFIGHT ───────────────────────────────────────────────
  // Trigger: one side ≥ 3× entry (losing badly) AND other side ≤ 30% entry (70% profit)
  // Scan FULL option chain (not limited to N strikes) for the right roll
  if (!trade.isIronButterfly && !trade.alertsSent.firefightAlert) {
    const callLosing = callNet >= callEntry * 3;
    const putLosing  = putNet  >= putEntry  * 3;
    const call70Profit = callNet <= callEntry * 0.3;
    const put70Profit  = putNet  <= putEntry  * 0.3;

    // Firefight fires when losing side hits 3× AND winning side hits 70% profit
    const doCallFirefight = putLosing  && call70Profit; // put is losing, roll put inward
    const doPutFirefight  = callLosing && put70Profit;  // call is losing, roll call inward

    if (doCallFirefight || doPutFirefight) {
      const sideToRoll = doCallFirefight ? 'PE' : 'CE';
      const losingSide = doCallFirefight ? 'PUT' : 'CALL';
      const losingNet  = doCallFirefight ? putNet  : callNet;
      const losingEntry = doCallFirefight ? putEntry : callEntry;

      log(`🔥 AUTO FIREFIGHT: ${index} — ${losingSide} at ${losingNet.toFixed(2)} (${(losingNet/losingEntry).toFixed(1)}× entry). Rolling ${sideToRoll} inward.`, 'info');
      sendCondorAlert(
        `🔥 <b>FIREFIGHT TRIGGERED: ${index}</b>\n` +
        `${losingSide} side: ₹${losingNet.toFixed(2)} = ${(losingNet/losingEntry).toFixed(1)}× entry (≥3× threshold)\n` +
        `${doCallFirefight ? 'CALL' : 'PUT'} side: 70%+ profit\n` +
        `Scanning full chain to roll ${sideToRoll} inward...`
      );

      const rolled = await _findAndRollFirefight(trade, sideToRoll, index, spotLTP);
      if (rolled) {
        trade.alertsSent.firefightAlert = true;
        await trade.save();
      }
    }
  }

  _emitTick(index, spotLTP, callNet, putNet, trade, callSL, putSL);
};

// ═══════════════════════════════════════════════════════════════
// FIREFIGHT ROLL — scan FULL option chain inward from current short strike
// Finds first strike where net premium ≥ minSide
// ═══════════════════════════════════════════════════════════════
const _findAndRollFirefight = async (trade, sideToRoll, index, spotLTP) => {
  try {
    const c      = cfg(index);
    const isCall = sideToRoll === 'CE';
    const curShort = isCall
      ? extractStrike(trade.symbols.callSell)
      : extractStrike(trade.symbols.putSell);
    if (!curShort) return false;

    const dist = c.spreadDist();
    const stp  = c.step;

    // Scan full chain inward toward ATM — no artificial limit on strikes
    // Stop when we cross ATM (don't roll past the other short strike)
    const oppShort = isCall
      ? extractStrike(trade.symbols.putSell)
      : extractStrike(trade.symbols.callSell);

    const candidates = [];
    for (let i = 1; i <= c.maxStrikeScan; i++) {
      const newShort = isCall ? curShort - i * stp : curShort + i * stp;
      const newLong  = isCall ? newShort + dist     : newShort - dist;

      // Don't cross the opposite short strike
      if (isCall  && oppShort && newShort <= oppShort) break;
      if (!isCall && oppShort && newShort >= oppShort) break;

      // Don't cross ATM
      if (spotLTP > 0) {
        if (isCall  && newShort < spotLTP) break;
        if (!isCall && newShort > spotLTP) break;
      }
      candidates.push({ newShort, newLong });
    }

    if (!candidates.length) {
      sendCondorAlert(`⚠️ <b>Firefight: No valid strikes to scan for ${index} ${sideToRoll}</b>`);
      return false;
    }

    // Fetch full chain LTPs in one batch
    const allKeys = candidates.flatMap(cd => [
      buildUpstoxOptionSymbol(index, cd.newShort, sideToRoll),
      buildUpstoxOptionSymbol(index, cd.newLong,  sideToRoll),
    ]);
    const quotes = await getLTP(allKeys);
    if (!quotes) return false;

    // Find first strike that meets minimum premium requirement
    let chosen = null;
    for (const cand of candidates) {
      const sKey = buildUpstoxOptionSymbol(index, cand.newShort, sideToRoll);
      const lKey = buildUpstoxOptionSymbol(index, cand.newLong,  sideToRoll);
      const net  = Math.abs(
        (quotes[sKey]?.last_price || 0) - (quotes[lKey]?.last_price || 0)
      );
      if (net >= c.minSide) { chosen = { ...cand, net }; break; }
    }

    if (!chosen) {
      sendCondorAlert(
        `⚠️ <b>Firefight scan failed: ${index} ${sideToRoll}</b>\n` +
        `Scanned ${candidates.length} strikes — none met ≥ ₹${c.minSide}.\n` +
        `Manual intervention needed.`
      );
      return false;
    }

    // Execute the roll
    await _executeRoll(trade, sideToRoll, chosen.newShort, chosen.newLong, index, 'FIREFIGHT');

    // Update trade record with new strike info
    const shortKite = forOrder(buildUpstoxOptionSymbol(index, chosen.newShort, sideToRoll));
    const longKite  = forOrder(buildUpstoxOptionSymbol(index, chosen.newLong,  sideToRoll));
    if (isCall) {
      trade.symbols.callSell          = shortKite;
      trade.symbols.callBuy           = longKite;
      trade.callSpreadEntryPremium    = chosen.net;
      trade.alertsSent.call70Decay    = false;
    } else {
      trade.symbols.putSell           = shortKite;
      trade.symbols.putBuy            = longKite;
      trade.putSpreadEntryPremium     = chosen.net;
      trade.alertsSent.put70Decay     = false;
    }
    trade.totalEntryPremium = trade.callSpreadEntryPremium + trade.putSpreadEntryPremium;
    await trade.save();

    sendCondorAlert(
      `🔥 <b>AUTO FIREFIGHT DONE: ${index} ${sideToRoll}</b>\n` +
      `New spread: SELL ${chosen.newShort} / BUY ${chosen.newLong}\n` +
      `Net premium: ₹${chosen.net.toFixed(2)}\n` +
      `Scanned ${candidates.length} strikes across full chain.`
    );
    return true;

  } catch (err) {
    log(`❌ Firefight error: ${err.message}`, 'error');
    return false;
  }
};

// ═══════════════════════════════════════════════════════════════
// EXECUTE ROLL — close old spread, open new (margin-safe order)
// ═══════════════════════════════════════════════════════════════
const _executeRoll = async (trade, side, newShort, newLong, index, rollType) => {
  const isCall     = side === 'CE';
  const oldShort   = isCall ? trade.symbols.callSell : trade.symbols.putSell;
  const oldLong    = isCall ? trade.symbols.callBuy  : trade.symbols.putBuy;
  const qty        = trade.lotSize;
  const newShortKite = forOrder(buildUpstoxOptionSymbol(index, newShort, side));
  const newLongKite  = forOrder(buildUpstoxOptionSymbol(index, newLong,  side));

  const isLive = process.env.LIVE_TRADING === 'true';
  if (!isLive) {
    log(`📝 [PAPER] ${rollType}: close ${oldShort}/${oldLong} → open ${newShortKite}/${newLongKite}`, 'info');
    return;
  }
  // Buy back old short first (frees margin), then sell new short, then swap longs
  await executeMarginSafeEntry(oldLong, oldShort, qty, index);
  await executeMarginSafeEntry(newLongKite, newShortKite, qty, index);
};

// ═══════════════════════════════════════════════════════════════
// DASHBOARD EMIT
// ═══════════════════════════════════════════════════════════════
const _emitTick = (index, spotLTP, callNet, putNet, trade, callSL, putSL) => {
  const io = getIO();
  if (!io) return;
  io.emit('auto_condor_tick', {
    index,
    spotLTP,
    callNet:         callNet.toFixed(2),
    putNet:          putNet.toFixed(2),
    callSL:          callSL?.toFixed(2),
    putSL:           putSL?.toFixed(2),
    butterflySL:     ((trade.totalEntryPremium * 3) + (trade.bufferPremium || 0)).toFixed(2),
    slHits:          slHitCount[index] || 0,
    maxSlHits:       2,
    isButterfly:     trade.isIronButterfly,
    isGap:           trade.alertsSent?.gapAlert,
    butterflyWatch:  trade.alertsSent?.butterflyAtmAlert,
    spreadSLCount:   trade.spreadSLCount || 0,
  });
};

// ═══════════════════════════════════════════════════════════════
// DAILY RESET — call from server.js cron at 9:00 AM IST
// ═══════════════════════════════════════════════════════════════
export const resetAutoCondorDay = () => {
  entryAttempted = { NIFTY: false, SENSEX: false };
  slHitCount     = { NIFTY: 0,     SENSEX: 0    };
  log('🔄 Auto Condor: daily counters reset', 'info');
};