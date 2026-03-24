// ─── Auto Condor Engine ───────────────────────────────────────────────────────
// Full-auto entry schedule, butterfly conversion, gap-open logic.
// SL and firefight are handled in ironCondorEngine (shared with semi-auto).
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import getActiveTradeModel              from "../models/activeTradeModel.js";
import { sendCondorAlert }              from "../services/telegramService.js";
import { kiteSymbolToToken }           from "../services/kiteSymbolMapper.js";
import {
  condorPrices,
  getSpotPrice,
  fetchFullOptionChain,
  convertToButterfly,
  exitAllLegs,
  enterIronCondor,
  getNearestExpiry,
} from "./ironCondorEngine.js";
import { getIO } from "../config/socket.js";
import { isFeedStale } from "../services/kiteLiveData.js";

// ─── Socket log helper ────────────────────────────────────────────────────────
const condorLog = (msg, level = "info") => {
  console.log(`[AUTO-CONDOR] ${msg}`);
  try {
    const io = getIO();
    if (io) io.emit("trade_log", {
      strategy: "CONDOR",
      time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
      level,
      msg,
    });
  } catch (_) {}

  // Telegram for success/warn/error — skip info (high-frequency polling messages)
  if (level === "info") return;
  const prefix = level === "success" ? "✅" : level === "warn" ? "⚠️" : "🚨";
  sendCondorAlert(`${prefix} <b>[Iron Condor]</b>\n${msg}`).catch(() => {});
};

// ─── Day state ────────────────────────────────────────────────────────────────
let _state = {
  armed:       false,
  entryDone:   false,
  gapOpenDone: false,
  gapOpenHold: false,
};

// Dedupe flags — prevent repeating the same log every 5 seconds
let _staleLogSent   = false;  // "feed stale" logged once until feed recovers
let _waitingLogDate = null;   // "not entry day" logged once per calendar date

export const resetAutoCondorDay = () => {
  _state = { armed: false, entryDone: false, gapOpenDone: false, gapOpenHold: false };
  _staleLogSent   = false;
  _waitingLogDate = null;
  console.log("🔄 Auto Condor day reset — disarmed");
  sendCondorAlert("🔴 <b>Auto Condor DISARMED</b>\nEngine stopped — no further auto entries or monitoring.").catch(() => {});
};

// Called by /api/auto-condor/trigger to arm the engine
export const armAutoCondor = () => {
  _state.armed = true;
  console.log("✅ Auto Condor armed");
  // ✅ Telegram alert on arm
  const enabledIndices = [
    process.env.NIFTY_AUTO  === "true" ? "NIFTY"  : null,
    process.env.SENSEX_AUTO === "true" ? "SENSEX" : null,
  ].filter(Boolean).join(", ") || "none";
  sendCondorAlert(`✅ <b>Auto Condor ARMED</b>\nIndex: ${enabledIndices}\nWaiting for entry day &amp; market open (09:20 IST).`).catch(() => {});
};

export const getAutoCondorState = () => ({ ..._state });

// ─── IST helpers ──────────────────────────────────────────────────────────────
const getIST = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return {
    day:     ist.getUTCDay(),
    hours:   ist.getUTCHours(),
    minutes: ist.getUTCMinutes(),
    date:    ist.toISOString().split("T")[0],
  };
};

const inEntryWindow     = (h, m) => h === 9 && m >= 20 && m <= 45; // ✅ Entry only 09:20–09:45 IST
const inGapOpenWindow   = (h, m) => h === 9 && m >= 15 && m <= 25;
// Gap open window has fully passed (after 9:25)
const pastGapOpenWindow = (h, m) => h > 9 || (h === 9 && m > 25);

// ─── Entry day resolver ───────────────────────────────────────────────────────
// Allows entry on BOTH the day before expiry AND on expiry day itself:
//   NIFTY:  Monday + Tuesday
//   SENSEX: Wednesday + Thursday
// Holiday shifts handled automatically — expiry day derived from getNearestExpiry.
// Override via NIFTY_ENTRY_DATE_OVERRIDE / SENSEX_ENTRY_DATE_OVERRIDE in .env.
const isEntryDay = async (index, date, day) => {
  const override = process.env[`${index}_ENTRY_DATE_OVERRIDE`];
  if (override) return date === override;

  const expiryDate = await getNearestExpiry(index);                   // "YYYY-MM-DD"
  const expiryDay  = new Date(expiryDate + "T00:00:00Z").getUTCDay(); // 0–6

  // One trading day before expiry; wrap Monday (1) back to Friday (5)
  const dayBefore = expiryDay === 1 ? 5 : expiryDay - 1;

  // ✅ Enter on day-before OR expiry day itself
  // NIFTY:  Mon (dayBefore=1) + Tue (expiryDay=2)
  // SENSEX: Wed (dayBefore=3) + Thu (expiryDay=4)
  return day === dayBefore || day === expiryDay;
};

// ─── Gap open check ───────────────────────────────────────────────────────────
const checkGapOpen = async (trade) => {
  if (_state.gapOpenDone) return;
  _state.gapOpenDone = true;

  const spread = trade.index === "SENSEX"
    ? parseInt(process.env.SENSEX_SPREAD_DISTANCE || "500")
    : parseInt(process.env.NIFTY_SPREAD_DISTANCE  || "150");

  const buffer         = trade.bufferPremium || 0;
  // Max loss = SPREAD_DISTANCE − (totalEntryPremium + bufferPremium)
  // Spread width is absolute worst case. Collected premium + buffer already reduces that.
  // The more you collected (including booked firefight profit), the less your max loss.
  const maxLossPerUnit = spread - (trade.totalEntryPremium + buffer);

  const callSellKey = kiteSymbolToToken(trade.symbols.callSell);
  const callBuyKey  = kiteSymbolToToken(trade.symbols.callBuy);
  const putSellKey  = kiteSymbolToToken(trade.symbols.putSell);
  const putBuyKey   = kiteSymbolToToken(trade.symbols.putBuy);

  const callNet = Math.max(0, (condorPrices[callSellKey] || 0) - (condorPrices[callBuyKey] || 0));
  const putNet  = Math.max(0, (condorPrices[putSellKey]  || 0) - (condorPrices[putBuyKey]  || 0));

  // currentLossPerUnit = how much MORE the spreads cost now vs what we collected
  // = (callNet + putNet) - totalEntryPremium
  // Positive → losing. Negative → still in profit.
  const currentLossPerUnit = (callNet + putNet) - trade.totalEntryPremium;
  const currentLossRs      = currentLossPerUnit * trade.quantity;
  const maxLossRs          = maxLossPerUnit * trade.quantity;

  console.log(`🔍 Gap open: currentLoss=₹${currentLossRs.toFixed(0)} maxLoss=₹${maxLossRs.toFixed(0)}`);
  condorLog(`🔍 GAP OPEN check | currentLoss=₹${currentLossRs.toFixed(0)} maxLoss=₹${maxLossRs.toFixed(0)}`, "warn");

  if (currentLossRs >= maxLossRs) {
    _state.gapOpenHold = true;
    condorLog(`⚠️ GAP OPEN — HOLDING till expiry | loss ₹${currentLossRs.toFixed(0)} ≥ max ₹${maxLossRs.toFixed(0)}`, "warn");
    await sendCondorAlert(
      `⚠️ <b>GAP OPEN — HOLDING TILL EXPIRY</b> · ${trade.index}\n` +
      `Current loss: ₹${currentLossRs.toFixed(0)} ≥ Max loss: ₹${maxLossRs.toFixed(0)}\n` +
      `<b>Do NOT exit — holding till expiry</b>`
    );
  } else {
    condorLog(`🔴 GAP OPEN EXIT | loss ₹${currentLossRs.toFixed(0)} < max ₹${maxLossRs.toFixed(0)} | exiting`, "error");
    await sendCondorAlert(
      `🔴 <b>GAP OPEN EXIT</b> · ${trade.index}\n` +
      `Current loss: ₹${currentLossRs.toFixed(0)} < Max: ₹${maxLossRs.toFixed(0)}\n` +
      `Exiting positions`
    );
    await exitAllLegs(trade, "GAP_OPEN_HOLD");
  }
};

// ─── Butterfly conversion check ───────────────────────────────────────────────
// Only runs on expiry day. Checks if a sell leg is now ATM AND its SL is hit.
const checkButterflyConversion = async (trade) => {
  if (trade.isIronButterfly) return;

  const interval = trade.index === "SENSEX" ? 100 : 50;

  let spot;
  try { spot = await getSpotPrice(trade.index); }
  catch (e) { console.error("❌ getSpotPrice butterfly:", e.message); return; }

  const atm = Math.round(spot / interval) * interval;

  // ✅ FIX: regex was correct but needed a guard for null/undefined symbols
  const extractStrike = (sym) => {
    if (!sym) return -1;
    const m = sym.match(/(\d+)(CE|PE)$/);
    return m ? parseInt(m[1]) : -1;
  };

  const callSellStrike = extractStrike(trade.symbols.callSell);
  const putSellStrike  = extractStrike(trade.symbols.putSell);
  const sideAtATM      = callSellStrike === atm ? "call" : putSellStrike === atm ? "put" : null;
  if (!sideAtATM) return;

  const buffer   = trade.bufferPremium || 0;
  const callKey  = kiteSymbolToToken(trade.symbols.callSell);
  const callBKey = kiteSymbolToToken(trade.symbols.callBuy);
  const putKey   = kiteSymbolToToken(trade.symbols.putSell);
  const putBKey  = kiteSymbolToToken(trade.symbols.putBuy);

  const callNet = Math.max(0, (condorPrices[callKey]  || 0) - (condorPrices[callBKey] || 0));
  const putNet  = Math.max(0, (condorPrices[putKey]   || 0) - (condorPrices[putBKey]  || 0));

  const slMult  = parseFloat(process.env.SL_MULTIPLIER || "4");
  const callSL  = trade.callSpreadEntryPremium * slMult + buffer;
  const putSL   = trade.putSpreadEntryPremium  * slMult + buffer;

  const slHit = (sideAtATM === "call" && callNet >= callSL) ||
                (sideAtATM === "put"  && putNet  >= putSL);

  if (!slHit) return;

  if (trade.slCount >= 1) {
    condorLog(`🛑 ATM SL + slCount=1 · ${trade.index} · exiting all`, "error");
    await sendCondorAlert(`🛑 <b>ATM SL + slCount=1</b> · ${trade.index} · Exiting all`);
    await exitAllLegs(trade, "BOTH_SL");
    return;
  }

  if (trade.mode === "FULL_AUTO") {
    condorLog(`🦋 BUTTERFLY triggered — ${trade.index} | ${sideAtATM} sell at ATM`, "warn");
    await convertToButterfly(trade, sideAtATM);  // sideAtATM is the LOSING side
  } else {
    // Semi-auto: set pending flag for UI banner
    if (!trade.butterflyPending) {
      // ✅ FIX: store butterflySide so server.js butterfly route knows which side to pass
      await getActiveTradeModel().updateOne({ _id: trade._id }, { $set: { butterflyPending: true, butterflySide: sideAtATM } });
      condorLog(`🦋 BUTTERFLY ALERT — ${trade.index} | sell leg at ATM + SL hit | awaiting dashboard action`, "warn");
      await sendCondorAlert(
        `🦋 <b>BUTTERFLY ALERT</b> · ${trade.index}\n` +
        `Sell leg at ATM + SL hit · Click butterfly button on dashboard`
      );
    }
  }
};

// ─── Auto entry ───────────────────────────────────────────────────────────────
export const autoEnterIfNeeded = async () => {
  if (!_state.armed)    return;
  if (_state.entryDone) return;

  const { day, hours, minutes, date } = getIST();
  if (!inEntryWindow(hours, minutes)) return; // ✅ Entry only 09:20–09:45 IST

  const ActiveTrade = getActiveTradeModel();
  const existing = await ActiveTrade.findOne({ status: { $in: ["ACTIVE", "EXITING"] } });
  if (existing) { _state.entryDone = true; return; }

  // ✅ Per-index enable flags — set NIFTY_AUTO=true and/or SENSEX_AUTO=true in .env
  // ✅ Quantity = DEFAULT_TRADE_LOTS × lot size for that index — no hardcoded quantity
  const lots = parseInt(process.env.DEFAULT_TRADE_LOTS || "5");

  const indexConfig = [
    {
      index:    "NIFTY",
      enabled:  process.env.NIFTY_AUTO === "true",
      lotSize:  parseInt(process.env.NIFTY_LOT_SIZE  || "65"),
    },
    {
      index:    "SENSEX",
      enabled:  process.env.SENSEX_AUTO === "true",
      lotSize:  parseInt(process.env.SENSEX_LOT_SIZE || "20"),
    },
  ];

  for (const { index, enabled, lotSize } of indexConfig) {
    if (!enabled) continue;

    if (!await isEntryDay(index, date, day)) {
      if (_waitingLogDate !== date) {
        _waitingLogDate = date;
        condorLog(`⏳ Auto armed | ${index} | today (day=${day}) is not entry day — waiting`, "info");
      }
      continue;
    }

    const quantity = lots * lotSize;
    condorLog(`🚀 Auto entry starting | ${index} | ${lots} lots × ${lotSize} = ${quantity} qty`, "info");
    // Lock entryDone BEFORE attempt — no retry ever on failure
    _state.entryDone = true;
    try {
      await enterIronCondor(index, quantity, "FULL_AUTO");
    } catch (err) {
      console.error(`❌ Auto entry ${index}:`, err.message);
      condorLog(`❌ Auto entry FAILED | ${index} | ${err.message} — manual intervention required`, "error");
      await sendCondorAlert(`❌ <b>Auto entry FAILED</b> · ${index}\n<code>${err.message}</code>\n⚠️ No retry — check Kite positions manually`);
    }
  }
};

// ─── Auto monitor tick — runs every 5 seconds ─────────────────────────────────
export const autoMonitorTick = async () => {
  if (!_state.armed) return;      // not armed — do nothing
  if (_state.gapOpenHold) return; // holding till expiry — skip all checks

  const { day, hours, minutes } = getIST();

  // ✅ STALE FEED GUARD: both checkGapOpen and checkButterflyConversion
  // read condorPrices directly. If the Kite feed has been dark for 30s+,
  // those prices are stale — acting on them could cause a wrong gap-open
  // decision or a false butterfly SL trigger.
  if (isFeedStale()) {
    if (!_state.gapOpenDone && pastGapOpenWindow(hours, minutes)) {
      _state.gapOpenDone = true;
      condorLog("⚠️ Gap open window passed while feed was stale — skipped safely", "warn");
    }
    // ✅ Log once when feed goes stale, not every 5 seconds
    if (!_staleLogSent) {
      _staleLogSent = true;
      condorLog("⏸ autoMonitorTick paused — Kite feed stale, prices unreliable", "warn");
    }
    return;
  }
  // ✅ Feed recovered — reset stale dedupe
  if (_staleLogSent) {
    _staleLogSent = false;
    condorLog("✅ Kite feed recovered — autoMonitorTick resuming", "success");
  }

  const ActiveTrade = getActiveTradeModel();
  const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
  if (!trade) return;

  // Gap open window: 9:15–9:25 IST
  if (inGapOpenWindow(hours, minutes) && !_state.gapOpenDone) {
    await checkGapOpen(trade);
    if (_state.gapOpenHold) return;
  }

  // Butterfly check — only on expiry day (Tue for NIFTY, Thu for SENSEX)
  const expiryDay = trade.index === "SENSEX" ? 4 : 2;
  if (day === expiryDay) {
    await checkButterflyConversion(trade);
  }
};