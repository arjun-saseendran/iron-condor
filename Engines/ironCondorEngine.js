// ─── Iron Condor Engine ───────────────────────────────────────────────────────
//
// DATA   : Kite WebSocket Ticker (real-time LTP, every tick triggers SL/FF checks)
// ORDERS : Kite REST only
// P&L    : Kite REST positions polled every 5 seconds
//
// ── KEY RULES ─────────────────────────────────────────────────────────────────
// Entry order:  BUY leg first, then SELL leg  (margin safety)
// Exit order:   SELL leg first (close short), then BUY leg (close long)
//
// SL per side:  entry × 4 + bufferPremium
// Firefight:    losing side net ≥ entry×3  AND  profit side net ≤ entry×0.30
//   → exit PROFIT side, book profit as buffer, enter fresh spread on profit side
//   → keep losing side open, its SL = entry×4 + newBuffer
// After firefight if losing hits SL: slCount=1, buffer reset to 0, fresh spread entered
// 2nd SL hit: exit ALL 4 legs immediately, done for day
//
// Butterfly (expiry day only, slCount=0):
//   sell leg becomes ATM AND that side SL hits → convert to butterfly
//   If slCount=1 and same trigger → exit all instead
//   Butterfly SL = totalEntryPremium×3 + buffer
//   Firefight applies once to butterfly, then exit all
//
// Gap open: maxLoss = spread − totalEntryPremium + buffer
//   currentLoss < maxLoss  → exit
//   currentLoss ≥ maxLoss  → hold till expiry, do NOT exit
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { getKiteInstance }               from "../config/kiteConfig.js";
import { getPCOptionChain, getLTP }      from "../config/kiteMarketData.js";
import { getIO }                         from "../config/socket.js";
import { sendCondorAlert }               from "../services/telegramService.js";
import { buildKiteSymbol, getKiteExchange } from "../services/kiteSymbolBuilder.js";
import { cacheSymbol, kiteSymbolToToken }  from "../services/kiteSymbolMapper.js";
import { subscribeCondorToken, onPriceUpdate, isFeedStale, getLastTickAge } from "../services/kiteLiveData.js";
import getActiveTradeModel               from "../models/activeTradeModel.js";
import { getCondorTradePerformanceModel } from "../models/tradePerformanceModel.js";

// ─── Live price store ─────────────────────────────────────────────────────────
export const condorPrices = {};

// ─── Socket log helper ────────────────────────────────────────────────────────
// Emits to the frontend log box AND console.logs.
// Also sends Telegram for important levels (success, warn, error).
// level: 'info' | 'success' | 'warn' | 'error'
//
// Telegram is intentionally skipped for 'info' level — those are high-frequency
// polling messages (price ticks, "not entry day" checks) that would spam the channel.
const condorLog = (msg, level = "info") => {
  console.log(`[CONDOR] ${msg}`);

  // ── Socket emit (UI log box) ──────────────────────────────────────────────
  try {
    const io = getIO();
    if (io) {
      io.emit("trade_log", {
        strategy: "CONDOR",
        time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
        level,
        msg,
      });
    }
  } catch (_) {}

  // ── Telegram (success / warn / error only — not info) ────────────────────
  if (level === "info") return;
  const prefix = level === "success" ? "✅"
               : level === "warn"    ? "⚠️"
               : "🚨"; // error
  sendCondorAlert(`${prefix} <b>[Iron Condor]</b>\n${msg}`).catch(() => {});
};

// ─── Reentrancy guard ─────────────────────────────────────────────────────────
// Prevents double-execution when two price ticks arrive simultaneously.
// ✅ FIX: guard is now reset in finally block in ALL code paths (was missing
//         reset path when _checkConditions threw inside onPriceUpdate handler,
//         causing the guard to permanently lock and freeze all future SL checks)
let _actionInProgress = false;

// ─── SL reset in-progress guard ───────────────────────────────────────────────
// ✅ FIX: duplicate SL alerts fired because onPriceUpdate tick AND scanAndSyncOrders
//         both call _checkConditions independently. _actionInProgress only blocks
//         within one caller — if tick and 5s scan fire at same millisecond, both
//         can enter executeSLReset. This flag blocks at the function level.
let _slResetInProgress = false;

// ─── Stale feed alert tracker ─────────────────────────────────────────────────
// Prevents sending repeated Telegram alerts every 5s when feed is dark.
// Resets when feed recovers so the "recovered" alert fires once.
let _staleAlertSent = false;

// ─── Kite positions/orders cache (updated every 5 seconds) ───────────────────
let _kitePositions = [];
let _kiteOrders    = [];

export const updateKitePositions = (positions) => { _kitePositions = positions || []; };
export const updateKiteOrders    = (orders)    => { _kiteOrders    = orders    || []; };
export const getKitePositions    = ()          => _kitePositions;
export const getKiteOrders       = ()          => _kiteOrders;

// ─── Config ───────────────────────────────────────────────────────────────────
const INDEX_KEY = {
  NIFTY:  "NSE:NIFTY 50",
  SENSEX: "BSE:SENSEX",
};

const SPREAD = {
  NIFTY:  () => parseInt(process.env.NIFTY_SPREAD_DISTANCE  || "150"),
  SENSEX: () => parseInt(process.env.SENSEX_SPREAD_DISTANCE || "500"),
};

const MIN_PREMIUM = {
  NIFTY:  () => parseFloat(process.env.NIFTY_MIN_PREMIUM  || "6"),
  SENSEX: () => parseFloat(process.env.SENSEX_MIN_PREMIUM || "20"),
};

const STRIKE_INTERVAL = { NIFTY: 50, SENSEX: 100 };
const LIVE = () => process.env.LIVE_TRADING === "true";

// ─── Price helpers ────────────────────────────────────────────────────────────
const getLtp = (kiteSymbol) => {
  if (!kiteSymbol) return 0;
  const token = kiteSymbolToToken(kiteSymbol);
  return token ? (condorPrices[token] || 0) : 0;
};

const getCallNet = (trade) =>
  Math.max(0, getLtp(trade.symbols.callSell) - getLtp(trade.symbols.callBuy));

const getPutNet = (trade) =>
  Math.max(0, getLtp(trade.symbols.putSell) - getLtp(trade.symbols.putBuy));

// P&L from Kite positions (authoritative). Returns null if Kite data not yet loaded.
export const getKitePnL = (trade) => {
  if (!_kitePositions.length) return null;
  const symbols = [
    trade.symbols.callSell, trade.symbols.callBuy,
    trade.symbols.putSell,  trade.symbols.putBuy,
  ].filter(Boolean);
  let pnl = 0;
  let found = false;
  for (const sym of symbols) {
    const pos = _kitePositions.find(p => p.tradingsymbol === sym);
    if (pos) { pnl += pos.pnl || 0; found = true; }
  }
  // ✅ FIX: return null if none of our symbols found in Kite positions yet
  // (avoids showing ₹0 P&L before Kite positions load the trade legs)
  return found ? pnl : null;
};

// ─── SL / firefight level calculators ────────────────────────────────────────
const SL_MULT       = () => parseFloat(process.env.SL_MULTIPLIER       || "4");
const FF_LOSS_MULT  = () => parseFloat(process.env.FF_LOSS_MULTIPLIER   || "3");
const FF_PROFIT_THR = () => parseFloat(process.env.FF_PROFIT_THRESHOLD  || "0.30");
const BF_SL_MULT    = () => parseFloat(process.env.BF_SL_MULTIPLIER     || "5");

const slLevel              = (entry, buffer) => entry * SL_MULT()       + buffer;
const firefightLossLevel   = (entry)         => entry * FF_LOSS_MULT();
const firefightProfitLevel = (entry)         => entry * FF_PROFIT_THR();
const butterflySLLevel     = (losingEntry, newEntry, buffer) => (losingEntry * BF_SL_MULT()) + newEntry + buffer;

// ─── Option chain ─────────────────────────────────────────────────────────────
export const fetchFullOptionChain = async (index, expiry) => {
  const chain = await getPCOptionChain(INDEX_KEY[index], expiry);
  if (!chain || !Array.isArray(chain))
    throw new Error(`Empty option chain for ${index} expiry=${expiry}`);

  return chain
    .map(row => ({
      strike:  row.strike_price,
      expiry:  row.expiry,
      callKey: row.call_options?.instrument_key || null,   // instrument_token
      putKey:  row.put_options?.instrument_key  || null,   // instrument_token
      callLtp: row.call_options?.market_data?.ltp || 0,
      putLtp:  row.put_options?.market_data?.ltp  || 0,
      callTradingsymbol: row.call_options?.tradingsymbol || null,
      putTradingsymbol:  row.put_options?.tradingsymbol  || null,
    }))
    .sort((a, b) => a.strike - b.strike);
};

export const getSpotPrice = async (index) => {
  // ✅ FIX: getLTP returns null/empty outside market hours (pre-open, post-close).
  //         Fall back to getLastClose (Kite OHLC previous close) so that
  //         after-hours preview, gap-open checks, and butterfly strike calculations
  //         still work. getLastClose is already used by optionChainRoutes for the
  //         same reason — this aligns the engine with that behaviour.
  const { getLastClose } = await import("../config/kiteMarketData.js");
  const key  = INDEX_KEY[index];
  const data = await getLTP([key]);
  const ltp  = data?.[key]?.last_price;
  if (ltp) return ltp;

  console.warn(`⚠️ LTP unavailable for ${index} — falling back to last close (OHLC)`);
  const lastClose = await getLastClose(key);
  if (lastClose) return lastClose;

  throw new Error(`Cannot fetch spot for ${index} (LTP and last-close both unavailable)`);
};

// Nearest expiry in IST: NIFTY=Tuesday(2), SENSEX=Thursday(4)
export const getNearestExpiry = (index) => {
  const targetDay = index === "SENSEX" ? 4 : 2;
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  for (let d = 0; d <= 7; d++) {
    const dt = new Date(ist);
    dt.setUTCDate(ist.getUTCDate() + d);
    if (dt.getUTCDay() === targetDay) {
      return dt.toISOString().split("T")[0];
    }
  }
  throw new Error(`Cannot find expiry for ${index}`);
};

// ─── Strike selection ─────────────────────────────────────────────────────────
// ✅ FIX: Scan outward from ATM, keep updating candidate while net >= minPremium.
//         Stop when net drops below minPremium — nothing further OTM will qualify.
//         Result: farthest OTM spread with net >= minPremium, guaranteed no valid
//         spread exists beyond it.
export const selectCondorStrikes = (strikes, spot, index) => {
  const spread     = SPREAD[index]();
  const minPremium = MIN_PREMIUM[index]();
  const interval   = STRIKE_INTERVAL[index];
  const atm        = Math.round(spot / interval) * interval;

  // Call side: scan from ATM outward, keep farthest valid spread
  let callSell = null, callBuy = null;
  for (let i = 0; i < strikes.length; i++) {
    if (strikes[i].strike < atm) continue;
    const buyRow = strikes.find(s => s.strike === strikes[i].strike + spread);
    if (!buyRow) continue;
    const net = strikes[i].callLtp - buyRow.callLtp;
    if (net >= minPremium) {
      callSell = strikes[i]; callBuy = buyRow;  // keep updating — farther is better
    } else if (callSell) {
      break;                                     // dropped below min — stop
    }
  }

  // Put side: scan from ATM outward, keep farthest valid spread
  let putSell = null, putBuy = null;
  for (let i = strikes.length - 1; i >= 0; i--) {
    if (strikes[i].strike > atm) continue;
    const buyRow = strikes.find(s => s.strike === strikes[i].strike - spread);
    if (!buyRow) continue;
    const net = strikes[i].putLtp - buyRow.putLtp;
    if (net >= minPremium) {
      putSell = strikes[i]; putBuy = buyRow;    // keep updating — farther is better
    } else if (putSell) {
      break;                                     // dropped below min — stop
    }
  }

  if (!callSell) throw new Error(`No call spread with net >= ${minPremium} for ${index}`);
  if (!putSell)  throw new Error(`No put spread with net >= ${minPremium} for ${index}`);

  return { callSell, callBuy, putSell, putBuy };
};

export const selectButterflyStrikes = (strikes, spot, index) => {
  const spread   = SPREAD[index]();
  const interval = STRIKE_INTERVAL[index];
  const atm      = Math.round(spot / interval) * interval;

  const atmRow     = strikes.find(s => s.strike === atm);
  const callBuyRow = strikes.find(s => s.strike === atm + spread);
  const putBuyRow  = strikes.find(s => s.strike === atm - spread);

  if (!atmRow)     throw new Error(`ATM strike ${atm} not found in chain`);
  if (!callBuyRow) throw new Error(`Call buy ${atm + spread} not found`);
  if (!putBuyRow)  throw new Error(`Put buy ${atm - spread} not found`);

  return { callSell: atmRow, callBuy: callBuyRow, putSell: atmRow, putBuy: putBuyRow };
};

export const findReplacementSpread = (strikes, spot, index, side) => {
  const spread     = SPREAD[index]();
  const minPremium = MIN_PREMIUM[index]();
  const interval   = STRIKE_INTERVAL[index];
  const atm        = Math.round(spot / interval) * interval;

  if (side === "call") {
    let best = null;
    for (let i = 0; i < strikes.length; i++) {
      if (strikes[i].strike < atm) continue;
      const buyRow = strikes.find(s => s.strike === strikes[i].strike + spread);
      if (!buyRow) continue;
      const net = strikes[i].callLtp - buyRow.callLtp;
      if (net >= minPremium) {
        best = { sell: strikes[i], buy: buyRow, net };
      } else if (best) {
        break;
      }
    }
    if (!best) throw new Error(`No replacement call spread with net >= ${minPremium}`);
    return best;
  } else {
    let best = null;
    for (let i = strikes.length - 1; i >= 0; i--) {
      if (strikes[i].strike > atm) continue;
      const buyRow = strikes.find(s => s.strike === strikes[i].strike - spread);
      if (!buyRow) continue;
      const net = strikes[i].putLtp - buyRow.putLtp;
      if (net >= minPremium) {
        best = { sell: strikes[i], buy: buyRow, net };
      } else if (best) {
        break;
      }
    }
    if (!best) throw new Error(`No replacement put spread with net >= ${minPremium}`);
    return best;
  }
};

// ─── Cache + subscribe legs ───────────────────────────────────────────────────
const cacheAndSubscribe = (kiteSymbol, instrumentToken) => {
  if (!kiteSymbol || !instrumentToken) return;
  cacheSymbol(kiteSymbol, instrumentToken);
  subscribeCondorToken(instrumentToken);
};

// ─── Kite order helpers ───────────────────────────────────────────────────────
// Always NRML — positions held till expiry, never intraday MIS
// place order → wait for Kite COMPLETE → return { orderId, avgPrice }
// If REJECTED or timeout → throw immediately, caller must handle

const placeAndConfirm = async (tradingsymbol, transactionType, quantity, index) => {
  if (!LIVE()) {
    const id = `PAPER-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // Use live WebSocket LTP as simulated fill price — realistic paper trading
    // getLtp() reads from condorPrices{} which is fed by Kite WebSocket
    // Symbol must already be subscribed via cacheAndSubscribe before this call
    const avgPrice = getLtp(tradingsymbol) || 0;
    console.log(`📝 [PAPER] ${transactionType} ${quantity} × ${tradingsymbol} @ ${avgPrice}`);
    // Simulate 200ms delay — mirrors real Kite confirm latency in paper mode
    await new Promise(r => setTimeout(r, 200));
    return { orderId: id, avgPrice };
  }

  const kc    = getKiteInstance();
  const order = await kc.placeOrder("regular", {
    exchange:         getKiteExchange(index),
    tradingsymbol,
    transaction_type: transactionType,
    quantity,
    order_type:       "MARKET",
    product:          "NRML",
    market_protection: 1,
  });

  const orderId = order.order_id;
  console.log(`⏳ Kite: ${transactionType} ${tradingsymbol} → waiting confirm (${orderId})`);

  // Poll Kite until COMPLETE or REJECTED — max 10 attempts × 500ms = 5s
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const orders = await kc.getOrders();
    const found  = orders.find(o => o.order_id === orderId);
    if (!found) continue;
    if (found.status === "COMPLETE") {
      const avgPrice = found.average_price || 0;
      console.log(`✅ Kite confirmed: ${transactionType} ${tradingsymbol} avgPrice=${avgPrice}`);
      return { orderId, avgPrice };
    }
    if (found.status === "REJECTED") {
      throw new Error(`REJECTED: ${tradingsymbol} — ${found.status_message || "no reason"}`);
    }
    // OPEN / PENDING — keep waiting
  }
  throw new Error(`Timeout: ${tradingsymbol} did not confirm in 5s`);
};

// ENTRY: BUY long leg first (confirmed), then SELL short leg (confirmed)
// Returns actual filled avgPrice for both legs from Kite
// If SELL fails after BUY confirmed — exit BUY immediately, throw
const enterSpread = async (sellSymbol, buySymbol, quantity, index) => {
  // 1. Place and confirm BUY
  let buyResult;
  try {
    buyResult = await placeAndConfirm(buySymbol, "BUY", quantity, index);
  } catch (buyErr) {
    throw new Error(`Entry aborted — BUY leg failed: ${buyErr.message}`);
  }

  // 2. Place and confirm SELL — only after BUY confirmed
  let sellResult;
  try {
    sellResult = await placeAndConfirm(sellSymbol, "SELL", quantity, index);
  } catch (sellErr) {
    // SELL failed — exit the confirmed BUY immediately to avoid naked position
    condorLog(`🚨 SELL failed (${sellSymbol}) — closing BUY leg ${buySymbol}`, "error");
    try { await placeAndConfirm(buySymbol, "SELL", quantity, index); } catch (_) {}
    throw new Error(`Entry aborted — SELL leg failed: ${sellErr.message}`);
  }

  // net = actual sell fill price − actual buy fill price
  const actualNet = Math.max(0, sellResult.avgPrice - buyResult.avgPrice);
  console.log(`✅ Spread entered: SELL ${sellSymbol} avg=${sellResult.avgPrice} BUY ${buySymbol} avg=${buyResult.avgPrice} net=${actualNet}`);

  return {
    sellId:   sellResult.orderId,
    buyId:    buyResult.orderId,
    sellAvg:  sellResult.avgPrice,
    buyAvg:   buyResult.avgPrice,
    actualNet,
  };
};

// EXIT WITH FILL: same as exitSpread but returns actual avgPrice from Kite for both legs
// Used in firefight to calculate real buffer from actual exit fill prices
const exitSpreadWithFill = async (sellSymbol, buySymbol, quantity, index) => {
  let buyBackAvg    = 0;
  let sellCloseAvg  = 0;

  // 1. Buy back the short leg
  try {
    const result = await placeAndConfirm(sellSymbol, "BUY", quantity, index);
    buyBackAvg = result.avgPrice;
  } catch (buyBackErr) {
    condorLog(`🚨 Exit BUY-BACK failed (${sellSymbol}): ${buyBackErr.message}`, "error");
    await sendCondorAlert(`🚨 <b>EXIT WARNING</b>
Buy-back failed: ${sellSymbol}
${buyBackErr.message}
⚠️ Check Kite positions manually`);
  }

  // 2. Close the long leg
  try {
    const result = await placeAndConfirm(buySymbol, "SELL", quantity, index);
    sellCloseAvg = result.avgPrice;
  } catch (sellCloseErr) {
    condorLog(`🚨 Exit SELL-CLOSE failed (${buySymbol}): ${sellCloseErr.message}`, "error");
    await sendCondorAlert(`🚨 <b>EXIT FAILURE</b>
Sell-close failed: ${buySymbol}
${sellCloseErr.message}
⚠️ Manual intervention required in Kite`);
  }

  return { buyBackAvg, sellCloseAvg };
};

// EXIT: close short (BUY back) first confirmed, then close long (SELL) confirmed
// If any leg fails — alert on Telegram, do not retry
const exitSpread = async (sellSymbol, buySymbol, quantity, index) => {
  // 1. Buy back the short leg
  try {
    await placeAndConfirm(sellSymbol, "BUY", quantity, index);
  } catch (buyBackErr) {
    condorLog(`🚨 Exit BUY-BACK failed (${sellSymbol}): ${buyBackErr.message} — attempting long leg close anyway`, "error");
    await sendCondorAlert(`🚨 <b>EXIT WARNING</b>
Buy-back failed: ${sellSymbol}
${buyBackErr.message}
⚠️ Check Kite positions manually`);
  }

  // 2. Close the long leg
  try {
    await placeAndConfirm(buySymbol, "SELL", quantity, index);
  } catch (sellCloseErr) {
    condorLog(`🚨 Exit SELL-CLOSE failed (${buySymbol}): ${sellCloseErr.message} — manual intervention required`, "error");
    await sendCondorAlert(`🚨 <b>EXIT FAILURE</b>
Sell-close failed: ${buySymbol}
${sellCloseErr.message}
⚠️ Manual intervention required in Kite`);
  }
};

// ─── ENTER IRON CONDOR ────────────────────────────────────────────────────────
// side: "both" (default) | "call" | "put"
// Entry premiums saved from actual Kite filled prices — not LTP
// If put spread fails after call spread entered — exit call spread immediately
// No retry ever — on any failure stop and alert
export const enterIronCondor = async (index, quantity, mode = "SEMI_AUTO", side = "both") => {
  const ActiveTrade = getActiveTradeModel();

  const existing = await ActiveTrade.findOne({ status: { $in: ["ACTIVE", "EXITING"] } });
  if (existing) throw new Error("Active trade already exists — exit first");

  const expiry  = getNearestExpiry(index);
  const spot    = await getSpotPrice(index);
  const strikes = await fetchFullOptionChain(index, expiry);
  const sel     = selectCondorStrikes(strikes, spot, index);

  const enterCall = side === "both" || side === "call";
  const enterPut  = side === "both" || side === "put";

  const callSellSym = enterCall ? buildKiteSymbol(index, expiry, sel.callSell.strike, "CE") : null;
  const callBuySym  = enterCall ? buildKiteSymbol(index, expiry, sel.callBuy.strike,  "CE") : null;
  const putSellSym  = enterPut  ? buildKiteSymbol(index, expiry, sel.putSell.strike,  "PE") : null;
  const putBuySym   = enterPut  ? buildKiteSymbol(index, expiry, sel.putBuy.strike,   "PE") : null;

  if (enterCall) {
    cacheAndSubscribe(callSellSym, sel.callSell.callKey);
    cacheAndSubscribe(callBuySym,  sel.callBuy.callKey);
  }
  if (enterPut) {
    cacheAndSubscribe(putSellSym, sel.putSell.putKey);
    cacheAndSubscribe(putBuySym,  sel.putBuy.putKey);
  }

  // Enter call spread first
  let callOrders = null;
  if (enterCall) {
    callOrders = await enterSpread(callSellSym, callBuySym, quantity, index);
  }

  // Enter put spread — if fails and call was entered, rollback call spread immediately
  let putOrders = null;
  if (enterPut) {
    try {
      putOrders = await enterSpread(putSellSym, putBuySym, quantity, index);
    } catch (putErr) {
      if (callOrders) {
        condorLog(`🚨 Put spread failed — rolling back call spread`, "error");
        await sendCondorAlert(`🚨 <b>ENTRY FAILED</b> · ${index}
Put spread failed: ${putErr.message}
Rolling back call spread — check Kite positions`);
        try { await exitSpread(callSellSym, callBuySym, quantity, index); } catch (_) {}
      }
      throw new Error(`Entry aborted — put spread failed: ${putErr.message}`);
    }
  }

  // Save actual filled prices from Kite — not LTP
  const callEntry  = callOrders ? callOrders.actualNet : 0;
  const putEntry   = putOrders  ? putOrders.actualNet  : 0;
  const totalEntry = callEntry + putEntry;

  // positionType drives _checkConditions routing — set once at entry, updated when structure changes
  const positionType = side === "call" ? "ONE_SIDE_CALL"
                     : side === "put"  ? "ONE_SIDE_PUT"
                     : "IRON_CONDOR";

  const trade = await ActiveTrade.create({
    index,
    status:   "ACTIVE",
    mode,
    positionType,
    symbols:  {
      callSell: callSellSym,
      callBuy:  callBuySym,
      putSell:  putSellSym,
      putBuy:   putBuySym,
    },
    orderIds: {
      callSell: callOrders?.sellId || null,
      callBuy:  callOrders?.buyId  || null,
      putSell:  putOrders?.sellId  || null,
      putBuy:   putOrders?.buyId   || null,
    },
    callSpreadEntryPremium: callEntry,
    putSpreadEntryPremium:  putEntry,
    totalEntryPremium:      totalEntry,
    quantity,
    expiry,
    bufferPremium:   0,
    slCount:         0,
    isIronButterfly: false,
  });

  await sendCondorAlert(
    `🦅 <b>Iron Condor ENTERED</b> · ${index} · ${mode} · ${side.toUpperCase()} side\n` +
    (enterCall ? `Call: SELL ${callSellSym} / BUY ${callBuySym} · Net: <b>${callEntry.toFixed(2)}</b>\n` : "") +
    (enterPut  ? `Put:  SELL ${putSellSym} / BUY ${putBuySym} · Net: <b>${putEntry.toFixed(2)}</b>\n`  : "") +
    `Total: <b>${totalEntry.toFixed(2)}</b> · Qty: ${quantity} · Expiry: ${expiry}`
  );

  condorLog(`🦅 ENTERED ${index} | side=${side} | call=${callEntry.toFixed(2)} put=${putEntry.toFixed(2)} total=${totalEntry.toFixed(2)} qty=${quantity}`, "success");
  return trade;
};

// ─── IMPORT FROM KITE ─────────────────────────────────────────────────────────
// If you entered manually in Kite broker app — call this to fetch your open
// positions, save actual filled prices to DB, and start monitoring.
// Supports one side (call only / put only) or both sides.
export const importTradeFromKite = async (index, quantity, mode = "SEMI_AUTO") => {
  const ActiveTrade = getActiveTradeModel();

  const existing = await ActiveTrade.findOne({ status: { $in: ["ACTIVE", "EXITING"] } });
  if (existing) throw new Error("Active trade already exists in DB — exit first");

  const kc       = getKiteInstance();
  const exchange = index === "SENSEX" ? "BFO" : "NFO";
  const expiry   = getNearestExpiry(index);

  // Fetch open positions from Kite
  const positions = await kc.getPositions();
  const openLegs  = (positions?.net || []).filter(
    p => p.exchange === exchange && p.quantity !== 0
  );

  if (openLegs.length === 0)
    throw new Error(`No open positions found in Kite for ${index} (${exchange})`);

  // Find call sell, call buy, put sell, put buy from open positions
  // sell leg = negative quantity (short), buy leg = positive quantity (long)
  const callLegs = openLegs.filter(p => p.tradingsymbol.endsWith("CE"));
  const putLegs  = openLegs.filter(p => p.tradingsymbol.endsWith("PE"));

  const callSell = callLegs.find(p => p.quantity < 0) || null;
  const callBuy  = callLegs.find(p => p.quantity > 0) || null;
  const putSell  = putLegs.find(p => p.quantity < 0)  || null;
  const putBuy   = putLegs.find(p => p.quantity > 0)  || null;

  if (!callSell && !putSell)
    throw new Error(`No short legs found in Kite for ${index} — cannot identify spreads`);

  // Actual entry premiums from Kite avg prices
  // sell avg − buy avg = net premium collected
  const callEntry = (callSell && callBuy)
    ? Math.max(0, callSell.sell_value / Math.abs(callSell.quantity) - callBuy.buy_value / callBuy.quantity)
    : 0;
  const putEntry = (putSell && putBuy)
    ? Math.max(0, putSell.sell_value / Math.abs(putSell.quantity) - putBuy.buy_value / putBuy.quantity)
    : 0;
  const totalEntry = callEntry + putEntry;

  // Subscribe to live prices for all legs
  const instruments = await kc.getInstruments([exchange]);
  const findToken = (sym) => instruments.find(i => i.tradingsymbol === sym)?.instrument_token || null;

  if (callSell) cacheAndSubscribe(callSell.tradingsymbol, findToken(callSell.tradingsymbol));
  if (callBuy)  cacheAndSubscribe(callBuy.tradingsymbol,  findToken(callBuy.tradingsymbol));
  if (putSell)  cacheAndSubscribe(putSell.tradingsymbol,  findToken(putSell.tradingsymbol));
  if (putBuy)   cacheAndSubscribe(putBuy.tradingsymbol,   findToken(putBuy.tradingsymbol));

  const trade = await ActiveTrade.create({
    index,
    status:   "ACTIVE",
    mode,
    symbols: {
      callSell: callSell?.tradingsymbol || null,
      callBuy:  callBuy?.tradingsymbol  || null,
      putSell:  putSell?.tradingsymbol  || null,
      putBuy:   putBuy?.tradingsymbol   || null,
    },
    orderIds: { callSell: null, callBuy: null, putSell: null, putBuy: null },
    callSpreadEntryPremium: callEntry,
    putSpreadEntryPremium:  putEntry,
    totalEntryPremium:      totalEntry,
    quantity,
    expiry,
    bufferPremium:   0,
    slCount:         0,
    isIronButterfly: false,
  });

  await sendCondorAlert(
    `📥 <b>Trade Imported from Kite</b> · ${index} · ${mode}\n` +
    (callSell ? `Call: SELL ${callSell.tradingsymbol} / BUY ${callBuy?.tradingsymbol} · Net: <b>${callEntry.toFixed(2)}</b>\n` : "Call: not entered\n") +
    (putSell  ? `Put:  SELL ${putSell.tradingsymbol}  / BUY ${putBuy?.tradingsymbol}  · Net: <b>${putEntry.toFixed(2)}</b>\n`  : "Put: not entered\n") +
    `Total: <b>${totalEntry.toFixed(2)}</b> · Qty: ${quantity} · Expiry: ${expiry}\n` +
    `Monitoring started`
  );

  condorLog(`📥 IMPORTED ${index} | call=${callEntry.toFixed(2)} put=${putEntry.toFixed(2)} total=${totalEntry.toFixed(2)} qty=${quantity}`, "success");
  return trade;
};

// ─── EXIT ALL 4 LEGS ──────────────────────────────────────────────────────────
export const exitAllLegs = async (trade, reason) => {
  const ActiveTrade = getActiveTradeModel();
  const CondorPerf  = getCondorTradePerformanceModel();

  // Re-fetch to prevent double-exit
  const current = await ActiveTrade.findById(trade._id);
  if (!current || current.status !== "ACTIVE") {
    console.warn(`⚠️ exitAllLegs skipped — status is ${current?.status}`);
    return;
  }
  await ActiveTrade.updateOne({ _id: trade._id }, { status: "EXITING" });

  const { callSell, callBuy, putSell, putBuy } = trade.symbols;
  const qty = trade.quantity;
  const idx = trade.index;

  try { await exitSpread(callSell, callBuy, qty, idx); } catch (e) { console.error("❌ exit call:", e.message); }
  try { await exitSpread(putSell,  putBuy,  qty, idx); } catch (e) { console.error("❌ exit put:",  e.message); }

  const kitePnl = getKitePnL(trade);
  const pnl = kitePnl !== null
    ? kitePnl
    : ((trade.callSpreadEntryPremium - getCallNet(trade)) + (trade.putSpreadEntryPremium - getPutNet(trade))) * qty;

  await ActiveTrade.updateOne({ _id: trade._id }, { status: "COMPLETED" });
  await CondorPerf.create({ activeTradeId: trade._id, index: idx, realizedPnL: pnl, exitReason: reason });

  const io = getIO();
  if (io) io.emit("condor:exited", { reason, pnl: pnl.toFixed(2), index: idx });

  await sendCondorAlert(
    `🔴 <b>Iron Condor EXITED</b> · ${idx}\nReason: <b>${reason}</b> · PnL: <b>₹${pnl.toFixed(2)}</b>`
  );
  condorLog(`🔴 EXITED ${idx} | reason=${reason} | PnL=₹${pnl.toFixed(2)}`, pnl >= 0 ? "success" : "error");
  console.log(`🔴 Exited ${idx} reason=${reason} pnl=${pnl.toFixed(2)}`);
};

// ─── FIREFIGHT ────────────────────────────────────────────────────────────────
export const executeFirefight = async (trade, profitSide) => {
  const ActiveTrade = getActiveTradeModel();

  const profitEntry = profitSide === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const losingSide  = profitSide === "call" ? "put" : "call";

  condorLog(`⚔️ FIREFIGHT triggered | exit ${profitSide} side | entry=${profitEntry.toFixed(2)}`, "warn");

  // 1. Exit profit side — get actual filled prices from Kite
  const profitSellSym = profitSide === "call" ? trade.symbols.callSell : trade.symbols.putSell;
  const profitBuySym  = profitSide === "call" ? trade.symbols.callBuy  : trade.symbols.putBuy;

  // exitSpread returns actual fill prices — buyBack avg and sellClose avg
  const exitResult = await exitSpreadWithFill(profitSellSym, profitBuySym, trade.quantity, trade.index);

  // actual premium received on exit = what we paid to close sell leg (buyBack) minus what we received to close buy leg (sellClose)
  // net cost to close = exitResult.buyBackAvg - exitResult.sellCloseAvg
  // actual profit booked = entry premium - net cost to close
  const exitNetCost   = Math.max(0, exitResult.buyBackAvg - exitResult.sellCloseAvg);
  const profitBooked  = Math.max(0, profitEntry - exitNetCost);
  const newBuffer     = (trade.bufferPremium || 0) + profitBooked;

  console.log(`⚔️ Firefight exit: buyBackAvg=${exitResult.buyBackAvg} sellCloseAvg=${exitResult.sellCloseAvg} exitNetCost=${exitNetCost.toFixed(2)} booked=${profitBooked.toFixed(2)}`);

  // 2. Fresh chain → find replacement
  const spot        = await getSpotPrice(trade.index);
  const strikes     = await fetchFullOptionChain(trade.index, trade.expiry);
  const replacement = findReplacementSpread(strikes, spot, trade.index, profitSide);

  const optType    = profitSide === "call" ? "CE" : "PE";
  const newSellSym = buildKiteSymbol(trade.index, trade.expiry, replacement.sell.strike, optType);
  const newBuySym  = buildKiteSymbol(trade.index, trade.expiry, replacement.buy.strike,  optType);

  if (profitSide === "call") {
    cacheAndSubscribe(newSellSym, replacement.sell.callKey);
    cacheAndSubscribe(newBuySym,  replacement.buy.callKey);
  } else {
    cacheAndSubscribe(newSellSym, replacement.sell.putKey);
    cacheAndSubscribe(newBuySym,  replacement.buy.putKey);
  }

  // 3. Enter new spread — actual filled price from Kite
  const newOrders = await enterSpread(newSellSym, newBuySym, trade.quantity, trade.index);
  const newEntry  = newOrders.actualNet; // actual fill from Kite

  // 4. Update DB
  const losingEntry = profitSide === "call" ? trade.putSpreadEntryPremium : trade.callSpreadEntryPremium;
  const newSL       = slLevel(losingEntry, newBuffer);

  const upd = {
    bufferPremium:    newBuffer,
    firefightPending: false,
    firefightSide:    null,
    totalEntryPremium:
      (profitSide === "call" ? newEntry                       : trade.callSpreadEntryPremium) +
      (profitSide === "put"  ? newEntry                       : trade.putSpreadEntryPremium),
  };
  if (profitSide === "call") {
    upd["symbols.callSell"]       = newSellSym;
    upd["symbols.callBuy"]        = newBuySym;
    upd["orderIds.callSell"]      = newOrders.sellId;
    upd["orderIds.callBuy"]       = newOrders.buyId;
    upd["callSpreadEntryPremium"] = newEntry;
  } else {
    upd["symbols.putSell"]        = newSellSym;
    upd["symbols.putBuy"]         = newBuySym;
    upd["orderIds.putSell"]       = newOrders.sellId;
    upd["orderIds.putBuy"]        = newOrders.buyId;
    upd["putSpreadEntryPremium"]  = newEntry;
  }
  await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });

  await sendCondorAlert(
    `⚔️ <b>FIREFIGHT DONE</b> · ${trade.index}\n` +
    `Exited ${profitSide} · Booked: <b>${profitBooked.toFixed(2)}</b> · Buffer: <b>${newBuffer.toFixed(2)}</b>\n` +
    `New ${profitSide}: SELL ${newSellSym} / BUY ${newBuySym} · Net: <b>${newEntry.toFixed(2)}</b>\n` +
    `${losingSide} SL now: <b>${newSL.toFixed(2)}</b>`
  );
  condorLog(`⚔️ FIREFIGHT DONE ${trade.index} | new ${profitSide}: ${newSellSym}/${newBuySym} net=${replacement.net.toFixed(2)} | buffer=₹${newBuffer.toFixed(2)}`, "success");
};

// ─── SL RESET ────────────────────────────────────────────────────────────────
export const executeSLReset = async (trade, losingSide) => {
  // ✅ FIX: block duplicate SL resets fired by concurrent tick + 5s scan
  if (_slResetInProgress) {
    console.warn(`⚠️ SL reset already in progress — skipping duplicate for ${losingSide}`);
    return;
  }
  _slResetInProgress = true;

  const ActiveTrade = getActiveTradeModel();
  const newSlCount  = (trade.slCount || 0) + 1;

  console.log(`🔴 SL hit on ${losingSide} — slCount becomes ${newSlCount}`);
  condorLog(`🔴 SL HIT on ${losingSide} | slCount=${newSlCount}`, "error");

  // 2nd SL → exit all immediately
  if (newSlCount >= 2) {
    await ActiveTrade.updateOne({ _id: trade._id }, { $set: { slCount: newSlCount } });
    const fresh = await ActiveTrade.findById(trade._id);
    await sendCondorAlert(`🛑 <b>2nd SL HIT</b> · ${trade.index} · Exiting all`);
    await exitAllLegs(fresh, "BOTH_SL");
    _slResetInProgress = false; // 🔓 Release guard
    return;
  }

  // 1st SL — exit losing spread, get actual fill prices from Kite
  const losingEntry    = losingSide === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const prevBookedLoss = trade.slBookedLoss || 0;

  // Exit losing spread — get actual fill prices for real loss calculation
  const losingSellSym = losingSide === "call" ? trade.symbols.callSell : trade.symbols.putSell;
  const losingBuySym  = losingSide === "call" ? trade.symbols.callBuy  : trade.symbols.putBuy;

  let slExitResult = { buyBackAvg: 0, sellCloseAvg: 0 };
  try {
    slExitResult = await exitSpreadWithFill(losingSellSym, losingBuySym, trade.quantity, trade.index);
  } catch (e) {
    console.error(`❌ SL exit error ${losingSide}:`, e.message);
    await sendCondorAlert(`🚨 <b>SL EXIT FAILED</b> · ${trade.index}
${losingSide} spread exit failed: ${e.message}
⚠️ Check Kite positions manually`);
  }

  // Actual loss from real fill prices
  const exitNetCost    = Math.max(0, slExitResult.buyBackAvg - slExitResult.sellCloseAvg);
  const slLossThisSide = Math.max(0, exitNetCost - losingEntry) * trade.quantity;

  // Enter fresh replacement spread — actual fill price from Kite
  const spot        = await getSpotPrice(trade.index);
  const strikes     = await fetchFullOptionChain(trade.index, trade.expiry);
  const replacement = findReplacementSpread(strikes, spot, trade.index, losingSide);

  const optType    = losingSide === "call" ? "CE" : "PE";
  const newSellSym = buildKiteSymbol(trade.index, trade.expiry, replacement.sell.strike, optType);
  const newBuySym  = buildKiteSymbol(trade.index, trade.expiry, replacement.buy.strike,  optType);

  if (losingSide === "call") {
    cacheAndSubscribe(newSellSym, replacement.sell.callKey);
    cacheAndSubscribe(newBuySym,  replacement.buy.callKey);
  } else {
    cacheAndSubscribe(newSellSym, replacement.sell.putKey);
    cacheAndSubscribe(newBuySym,  replacement.buy.putKey);
  }

  const newOrders = await enterSpread(newSellSym, newBuySym, trade.quantity, trade.index);
  const newEntry  = newOrders.actualNet; // actual fill from Kite — not LTP

  const upd = {
    slCount:             newSlCount,
    bufferPremium:       0,
    postSlFirefightDone: false,
    slBookedLoss:        prevBookedLoss + slLossThisSide,
    totalEntryPremium:
      (losingSide === "call" ? newEntry : trade.callSpreadEntryPremium) +
      (losingSide === "put"  ? newEntry : trade.putSpreadEntryPremium),
  };
  if (losingSide === "call") {
    upd["symbols.callSell"]       = newSellSym;
    upd["symbols.callBuy"]        = newBuySym;
    upd["orderIds.callSell"]      = newOrders.sellId;
    upd["orderIds.callBuy"]       = newOrders.buyId;
    upd["callSpreadEntryPremium"] = newEntry;
  } else {
    upd["symbols.putSell"]        = newSellSym;
    upd["symbols.putBuy"]         = newBuySym;
    upd["orderIds.putSell"]       = newOrders.sellId;
    upd["orderIds.putBuy"]        = newOrders.buyId;
    upd["putSpreadEntryPremium"]  = newEntry;
  }
  await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });

  await sendCondorAlert(
    `🔄 <b>SL Reset</b> · ${trade.index} · ${losingSide}\n` +
    `New: SELL ${newSellSym} / BUY ${newBuySym} · Net: <b>${newEntry.toFixed(2)}</b>\n` +
    `slCount: <b>${newSlCount}</b> · Buffer: reset to 0`
  );
  condorLog(`🔄 SL RESET ${trade.index} | ${losingSide} | new: ${newSellSym}/${newBuySym} net=${newEntry.toFixed(2)} | slCount=${newSlCount}`, "warn");
  _slResetInProgress = false; // 🔓 Release guard
};

// ─── CONVERT TO BUTTERFLY ─────────────────────────────────────────────────────
// Correct logic:
// 1. Identify which side is the PROFIT side (not ATM, not losing)
// 2. Exit ONLY the profit side — book that profit as buffer
// 3. Keep the LOSING side open as-is (already has ATM sell + wing buy)
// 4. Enter a fresh ATM spread on the profit side to mirror the losing side at ATM
// Result: both sell legs now at ATM = Iron Butterfly
// The losing side positions are REUSED — no close/reopen needed on that side
export const convertToButterfly = async (trade, losingSide) => {
  const ActiveTrade = getActiveTradeModel();
  const profitSide  = losingSide === "call" ? "put" : "call";

  console.log(`🦋 Converting to Butterfly — ${trade.index} | exit ${profitSide} side, keep ${losingSide} side`);
  condorLog(`🦋 BUTTERFLY conversion started — ${trade.index} | exiting profit side (${profitSide})`, "warn");

  // 1. Exit profit side — actual fill prices from Kite for real buffer calculation
  const profitEntry   = profitSide === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const profitSellSym = profitSide === "call" ? trade.symbols.callSell : trade.symbols.putSell;
  const profitBuySym  = profitSide === "call" ? trade.symbols.callBuy  : trade.symbols.putBuy;

  const exitResult   = await exitSpreadWithFill(profitSellSym, profitBuySym, trade.quantity, trade.index);
  const exitNetCost  = Math.max(0, exitResult.buyBackAvg - exitResult.sellCloseAvg);
  const profitBooked = Math.max(0, profitEntry - exitNetCost);
  const newBuffer    = (trade.bufferPremium || 0) + profitBooked;

  // 2. Find ATM strike — must match the losing side's sell leg strike
  const spot    = await getSpotPrice(trade.index);
  const strikes = await fetchFullOptionChain(trade.index, trade.expiry);
  const sel     = selectButterflyStrikes(strikes, spot, trade.index);

  // 3. Enter fresh ATM spread on the profit side (mirrors the losing side at ATM)
  const optType     = profitSide === "call" ? "CE" : "PE";
  const newSellSym  = buildKiteSymbol(trade.index, trade.expiry, sel.callSell.strike, optType);
  const newBuySym   = buildKiteSymbol(trade.index, trade.expiry,
    profitSide === "call" ? sel.callBuy.strike : sel.putBuy.strike, optType);

  if (profitSide === "call") {
    cacheAndSubscribe(newSellSym, sel.callSell.callKey);
    cacheAndSubscribe(newBuySym,  sel.callBuy.callKey);
  } else {
    cacheAndSubscribe(newSellSym, sel.callSell.callKey);
    cacheAndSubscribe(newBuySym,  sel.putBuy.putKey);
  }

  const newOrders = await enterSpread(newSellSym, newBuySym, trade.quantity, trade.index);
  const newEntry  = newOrders.actualNet; // actual fill from Kite — not LTP

  // 4. Update DB — keep losing side symbols unchanged, update profit side to new ATM spread
  const losingEntry = losingSide === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const totalEntry  = losingEntry + newEntry;
  // bfSL = (losingEntry × 5) + newEntry + buffer
  // Real loss at exit = bfSL - (losingEntry + newEntry + buffer) = losingEntry × 4 = 2%
  const bfSL = butterflySLLevel(losingEntry, newEntry, newBuffer);

  const upd = {
    isIronButterfly:            true,
    losingSpreadEntryPremium:   losingEntry, // original losing side collected premium
    newSpreadEntryPremium:      newEntry,    // fresh ATM spread collected premium
    butterflySL:                bfSL,        // stored once — checked on every tick
    butterflyPending:  false,
    bufferPremium:     newBuffer,
    totalEntryPremium: totalEntry,
  };

  if (profitSide === "call") {
    upd["symbols.callSell"]       = newSellSym;
    upd["symbols.callBuy"]        = newBuySym;
    upd["orderIds.callSell"]      = newOrders.sellId;
    upd["orderIds.callBuy"]       = newOrders.buyId;
    upd["callSpreadEntryPremium"] = newEntry;
  } else {
    upd["symbols.putSell"]        = newSellSym;
    upd["symbols.putBuy"]         = newBuySym;
    upd["orderIds.putSell"]       = newOrders.sellId;
    upd["orderIds.putBuy"]        = newOrders.buyId;
    upd["putSpreadEntryPremium"]  = newEntry;
  }

  await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });

  await sendCondorAlert(
    `🦋 <b>Butterfly Entered</b> · ${trade.index} · ATM: ${sel.callSell.strike}\n` +
    `Exited ${profitSide} · Booked: ₹${profitBooked.toFixed(2)} · Buffer: ₹${newBuffer.toFixed(2)}\n` +
    `New ${profitSide}: SELL ${newSellSym} / BUY ${newBuySym} · Net: ${newEntry.toFixed(2)}\n` +
    `Total entry: ${totalEntry.toFixed(2)} · SL: <b>${bfSL.toFixed(2)}</b>`
  );
  condorLog(`🦋 BUTTERFLY ENTERED ${trade.index} | ATM=${sel.callSell.strike} | exited=${profitSide} booked=₹${profitBooked.toFixed(2)} | totalEntry=${totalEntry.toFixed(2)} SL=${bfSL.toFixed(2)}`, "success");
};

// ─── PRICE TICK HANDLER ───────────────────────────────────────────────────────
// SL/FF checks run on every Kite WebSocket price tick (real-time).
// Kite P&L poll runs separately every 5 seconds.
onPriceUpdate(async (instrumentToken, ltp) => {
  condorPrices[instrumentToken] = ltp;

  // ✅ Feed recovered — capture age BEFORE condorPrices update overwrites timing context.
  // _lastTickTime was already refreshed inside kiteLiveData on this tick,
  // so getLastTickAge() would return ~0. We track dark duration separately.
  if (_staleAlertSent) {
    _staleAlertSent = false;
    // ✅ FIX: only alert if active trade exists — no spam after market hours
    const ActiveTrade = getActiveTradeModel();
    const hasTrade = await ActiveTrade.findOne({ status: "ACTIVE" }).lean().catch(() => null);
    if (hasTrade) condorLog(`✅ Kite feed RECOVERED — SL/FF checks resuming`, "success");
  }

  const io = getIO();
  if (io) io.emit("condor:price", { key: instrumentToken, ltp });

  if (_actionInProgress) return;

  const ActiveTrade = getActiveTradeModel();
  const trade = await ActiveTrade.findOne({ status: "ACTIVE" }).lean().catch(() => null);
  if (!trade) return;

  _actionInProgress = true;
  try {
    await _checkConditions(trade);
  } catch (err) {
    console.error("❌ Price tick check error:", err.message);
  } finally {
    // ✅ FIX: always release guard — was correct here, confirmed safe
    _actionInProgress = false;
  }
});

// ─── ONE SIDE CHECKER ────────────────────────────────────────────────────────
// Called when positionType is ONE_SIDE_CALL or ONE_SIDE_PUT.
// Rules:
//   30% decay  → book profit, enter fresh OTM same side, buffer grows (same as condor firefight same-side)
//   3x loss    → SEMI_AUTO: Telegram alert + dashboard suggestion to enter opposite side
//              → FULL_AUTO: enter opposite side confirmed from Kite → positionType = IRON_CONDOR
//   SL (4x+buffer) → same slLevel() function, reset same side to fresh OTM
// All orders confirmed from Kite before any state change.
const _checkOneSide = async (trade) => {
  const ActiveTrade = getActiveTradeModel();
  const side   = trade.positionType === "ONE_SIDE_CALL" ? "call" : "put";
  const oppSide = side === "call" ? "put" : "call";

  const net    = side === "call" ? getCallNet(trade) : getPutNet(trade);
  const entry  = side === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const buffer = trade.bufferPremium || 0;

  // ── 30% decay → book profit, enter fresh OTM same side ───────────────────
  if (net <= firefightProfitLevel(entry)) {
    condorLog(`💰 ONE-SIDE PROFIT | ${side} decayed to ${net.toFixed(2)} (entry=${entry.toFixed(2)}) — booking profit, rolling same side`, "warn");

    const sellSym = side === "call" ? trade.symbols.callSell : trade.symbols.putSell;
    const buySym  = side === "call" ? trade.symbols.callBuy  : trade.symbols.putBuy;

    // Exit current spread — actual fill from Kite
    const exitResult  = await exitSpreadWithFill(sellSym, buySym, trade.quantity, trade.index);
    const exitNetCost = Math.max(0, exitResult.buyBackAvg - exitResult.sellCloseAvg);
    const booked      = Math.max(0, entry - exitNetCost);
    const newBuffer   = buffer + booked;

    // Enter fresh OTM same side — confirmed from Kite
    const spot        = await getSpotPrice(trade.index);
    const strikes     = await fetchFullOptionChain(trade.index, trade.expiry);
    const replacement = findReplacementSpread(strikes, spot, trade.index, side);
    const optType     = side === "call" ? "CE" : "PE";
    const newSellSym  = buildKiteSymbol(trade.index, trade.expiry, replacement.sell.strike, optType);
    const newBuySym   = buildKiteSymbol(trade.index, trade.expiry, replacement.buy.strike,  optType);

    if (side === "call") {
      cacheAndSubscribe(newSellSym, replacement.sell.callKey);
      cacheAndSubscribe(newBuySym,  replacement.buy.callKey);
    } else {
      cacheAndSubscribe(newSellSym, replacement.sell.putKey);
      cacheAndSubscribe(newBuySym,  replacement.buy.putKey);
    }

    // Confirmed from Kite before saving anything
    const newOrders = await enterSpread(newSellSym, newBuySym, trade.quantity, trade.index);
    const newEntry  = newOrders.actualNet;

    const upd = {
      bufferPremium: newBuffer,
      totalEntryPremium: newEntry,
    };
    if (side === "call") {
      upd["symbols.callSell"]       = newSellSym;
      upd["symbols.callBuy"]        = newBuySym;
      upd["orderIds.callSell"]      = newOrders.sellId;
      upd["orderIds.callBuy"]       = newOrders.buyId;
      upd["callSpreadEntryPremium"] = newEntry;
    } else {
      upd["symbols.putSell"]        = newSellSym;
      upd["symbols.putBuy"]         = newBuySym;
      upd["orderIds.putSell"]       = newOrders.sellId;
      upd["orderIds.putBuy"]        = newOrders.buyId;
      upd["putSpreadEntryPremium"]  = newEntry;
    }
    await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });

    await sendCondorAlert(
      `💰 <b>One-Side Profit Booked</b> · ${trade.index} · ${side}
` +
      `Booked: ₹${booked.toFixed(2)} · Buffer: ₹${newBuffer.toFixed(2)}
` +
      `New ${side}: SELL ${newSellSym} / BUY ${newBuySym} · Net: ${newEntry.toFixed(2)}`
    );
    condorLog(`💰 ONE-SIDE PROFIT ROLLED ${trade.index} | ${side} booked=₹${booked.toFixed(2)} buffer=₹${newBuffer.toFixed(2)} newEntry=${newEntry.toFixed(2)}`, "success");
    return;
  }

  // ── 3x loss → suggest or auto-enter opposite side ────────────────────────
  if (net >= firefightLossLevel(entry)) {
    if (trade.mode === "FULL_AUTO") {
      condorLog(`⚔️ ONE-SIDE 3x LOSS | ${side} at ${net.toFixed(2)} — entering opposite side ${oppSide} (FULL_AUTO)`, "warn");

      const spot        = await getSpotPrice(trade.index);
      const strikes     = await fetchFullOptionChain(trade.index, trade.expiry);
      const replacement = findReplacementSpread(strikes, spot, trade.index, oppSide);
      const optType     = oppSide === "call" ? "CE" : "PE";
      const newSellSym  = buildKiteSymbol(trade.index, trade.expiry, replacement.sell.strike, optType);
      const newBuySym   = buildKiteSymbol(trade.index, trade.expiry, replacement.buy.strike,  optType);

      if (oppSide === "call") {
        cacheAndSubscribe(newSellSym, replacement.sell.callKey);
        cacheAndSubscribe(newBuySym,  replacement.buy.callKey);
      } else {
        cacheAndSubscribe(newSellSym, replacement.sell.putKey);
        cacheAndSubscribe(newBuySym,  replacement.buy.putKey);
      }

      // Confirmed from Kite — only after this do we update DB
      const newOrders = await enterSpread(newSellSym, newBuySym, trade.quantity, trade.index);
      const newEntry  = newOrders.actualNet;

      const upd = {
        positionType: "IRON_CONDOR", // ✅ now full condor — all existing condor logic takes over
        totalEntryPremium:
          (oppSide === "call" ? newEntry : trade.callSpreadEntryPremium) +
          (oppSide === "put"  ? newEntry : trade.putSpreadEntryPremium),
      };
      if (oppSide === "call") {
        upd["symbols.callSell"]       = newSellSym;
        upd["symbols.callBuy"]        = newBuySym;
        upd["orderIds.callSell"]      = newOrders.sellId;
        upd["orderIds.callBuy"]       = newOrders.buyId;
        upd["callSpreadEntryPremium"] = newEntry;
      } else {
        upd["symbols.putSell"]        = newSellSym;
        upd["symbols.putBuy"]         = newBuySym;
        upd["orderIds.putSell"]       = newOrders.sellId;
        upd["orderIds.putBuy"]        = newOrders.buyId;
        upd["putSpreadEntryPremium"]  = newEntry;
      }
      await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });

      await sendCondorAlert(
        `⚔️ <b>One-Side → Iron Condor</b> · ${trade.index}
` +
        `${side} at 3x loss · Entered ${oppSide} side (confirmed Kite)
` +
        `${oppSide}: SELL ${newSellSym} / BUY ${newBuySym} · Net: ${newEntry.toFixed(2)}
` +
        `Now monitoring as full Iron Condor`
      );
      condorLog(`⚔️ ONE-SIDE → IRON_CONDOR ${trade.index} | entered ${oppSide} net=${newEntry.toFixed(2)} | positionType=IRON_CONDOR`, "success");

    } else {
      // SEMI_AUTO — alert only, show suggestion on dashboard
      if (!trade.oppositeSidePending) {
        await ActiveTrade.updateOne({ _id: trade._id }, { $set: { oppositeSidePending: true, oppositeSide: oppSide } });
        await sendCondorAlert(
          `⚠️ <b>One-Side 3x Loss</b> · ${trade.index} · ${side}
` +
          `net=${net.toFixed(2)} entry=${entry.toFixed(2)}
` +
          `Suggestion: Enter ${oppSide.toUpperCase()} side now
` +
          `Click on dashboard to confirm`
        );
        condorLog(`⚠️ ONE-SIDE 3x LOSS ALERT ${trade.index} | ${side} at 3x | suggest entering ${oppSide}`, "warn");
      }
    }
    return;
  }

  // ── SL (4x + buffer) → reset same side to fresh OTM ─────────────────────
  const sl    = slLevel(entry, buffer);
  const slHit = net >= sl;
  if (slHit) {
    condorLog(`🔴 ONE-SIDE SL HIT | ${side} net=${net.toFixed(2)} sl=${sl.toFixed(2)} slCount=${trade.slCount}`, "error");
    // Re-use existing executeSLReset — same logic, exits losing side, enters fresh OTM same side
    await executeSLReset(trade, side);
  }
};

// ─── CONDITION CHECKER ───────────────────────────────────────────────────────
const _checkConditions = async (trade) => {
  // Route one-side positions to their own checker — avoids wrong condor logic firing
  if (trade.positionType === "ONE_SIDE_CALL" || trade.positionType === "ONE_SIDE_PUT") {
    return _checkOneSide(trade);
  }

  const hasCall = !!(trade.symbols.callSell && trade.symbols.callBuy && trade.callSpreadEntryPremium > 0);
  const hasPut  = !!(trade.symbols.putSell  && trade.symbols.putBuy  && trade.putSpreadEntryPremium  > 0);

  if (!hasCall && !hasPut) return;

  const callNet    = hasCall ? getCallNet(trade) : null;
  const putNet     = hasPut  ? getPutNet(trade)  : null;
  const buffer     = trade.bufferPremium || 0;
  const callEntry  = trade.callSpreadEntryPremium;
  const putEntry   = trade.putSpreadEntryPremium;
  const totalEntry = trade.totalEntryPremium;

  // ── Butterfly SL ────────────────────────────────────────────────────────────
  // Only for iron butterfly positions (slCount=0, expiry day conversion).
  // bfSL is calculated ONCE at conversion and stored in DB:
  //   bfSL = (losingEntry × 5) + newEntry + buffer
  // On every tick: if live (callNet + putNet) >= bfSL → real loss = 2% → exit.
  if (trade.isIronButterfly) {
    if (!hasCall || !hasPut) return; // butterfly needs both sides
    const bfSL  = trade.butterflySL;
    const bfNet = callNet + putNet;
    if (bfNet >= bfSL) {
      console.log(`🛑 Butterfly SL hit bfNet=${bfNet.toFixed(2)} bfSL=${bfSL.toFixed(2)}`);
      condorLog(`🛑 BUTTERFLY SL HIT | bfNet=${bfNet.toFixed(2)} bfSL=${bfSL.toFixed(2)} | exiting all`, "error");
      await exitAllLegs(trade, "BUTTERFLY_SL");
    }
    return;
  }

  // ── Firefight check ─────────────────────────────────────────────────────────
  // ✅ FIX: firefight cross-check was wrong.
  // Original: callLosing used putFFProfit, putLosing used callFFProfit
  // This is CORRECT because the profit side is the OTHER side.
  // callLosing = call is losing → put is the profit side → check put's profit level
  // putLosing  = put is losing  → call is the profit side → check call's profit level
  // Confirmed logic is correct as written.
  // Firefight only possible when both sides exist
  const callLosing = hasCall && hasPut && callNet >= firefightLossLevel(callEntry) && putNet  <= firefightProfitLevel(putEntry);
  const putLosing  = hasCall && hasPut && putNet  >= firefightLossLevel(putEntry)  && callNet <= firefightProfitLevel(callEntry);

  // ✅ NEW: Post-SL single-side firefight logic
  // After slCount=1 and postSlFirefightDone=false:
  //   If profit side reaches 70% decay (net ≤ entry × 0.30) → firefight that side ALONE
  //   No need to wait for losing side to reach 3x — market is trending, lock profit now
  // After post-SL firefight done → postSlFirefightDone=true → resume normal dual-condition rules
  if (trade.slCount >= 1 && !trade.postSlFirefightDone && hasCall && hasPut) {
    const callDecayed = callNet <= firefightProfitLevel(callEntry);
    const putDecayed  = putNet  <= firefightProfitLevel(putEntry);

    // Determine which side is profit (decayed) — only act if exactly one side decayed
    const postSlProfitSide = callDecayed && !putDecayed ? "call"
                           : putDecayed  && !callDecayed ? "put"
                           : null;

    if (postSlProfitSide) {
      condorLog(`⚔️ POST-SL FIREFIGHT | slCount=${trade.slCount} | ${postSlProfitSide} decayed 70% — firefighting without waiting for other side 3x`, "warn");

      if (trade.mode === "FULL_AUTO") {
        // Mark postSlFirefightDone BEFORE executing to prevent duplicate triggers
        await getActiveTradeModel().updateOne({ _id: trade._id }, { $set: { postSlFirefightDone: true } });
        await executeFirefight(trade, postSlProfitSide);
      } else {
        if (!trade.firefightPending) {
          await getActiveTradeModel().updateOne({ _id: trade._id }, {
            $set: { firefightPending: true, firefightSide: postSlProfitSide, postSlFirefightDone: true }
          });
          condorLog(`⚔️ POST-SL FIREFIGHT ALERT | profit=${postSlProfitSide} decayed 70% | awaiting dashboard action`, "warn");
          await sendCondorAlert(
            `⚔️ <b>POST-SL FIREFIGHT ALERT</b> · ${trade.index}\n` +
            `slCount=1 · ${postSlProfitSide} decayed 70% · Lock profit now\n` +
            `Click firefight on dashboard`
          );
        }
      }
      return;
    }
  }

  if (callLosing || putLosing) {
    const profitSide = callLosing ? "put" : "call";

    if (trade.mode === "FULL_AUTO") {
      await executeFirefight(trade, profitSide);
    } else {
      if (!trade.firefightPending) {
        await getActiveTradeModel().updateOne({ _id: trade._id }, {
          $set: { firefightPending: true, firefightSide: profitSide }
        });
        condorLog(`⚔️ FIREFIGHT ALERT | losing=${callLosing ? "call" : "put"} profit=${profitSide} | awaiting dashboard action`, "warn");
        await sendCondorAlert(
          `⚔️ <b>FIREFIGHT ALERT</b> · ${trade.index}\n` +
          `Losing: ${callLosing ? "call" : "put"} · Click firefight on dashboard`
        );
      }
    }
    return;
  }

  // ── Spread SL (both modes — SL always automated) ────────────────────────────
  // Only check SL for sides that actually exist — null side skipped
  const callSL    = hasCall ? slLevel(callEntry, buffer) : Infinity;
  const putSL     = hasPut  ? slLevel(putEntry,  buffer) : Infinity;
  const callSLHit = hasCall && callNet >= callSL;
  const putSLHit  = hasPut  && putNet  >= putSL;

  if (callSLHit || putSLHit) {
    // ✅ FIX: if both SLs hit simultaneously (gap open scenario), treat as 2nd SL
    //         Original code only handled one side — the put side would be silently ignored
    //         if call hit first and slCount was already 1 from a previous reset.
    //         Now: if both hit at once on first iron condor (slCount=0), handle call
    //         first which sets slCount=1, then put will be caught on next tick as 2nd SL.
    //         This is safe — the reentrancy guard ensures they don't fire simultaneously.
    condorLog(`🔴 SPREAD SL | call=${callNet.toFixed(2)}/${callSL.toFixed(2)} put=${putNet.toFixed(2)}/${putSL.toFixed(2)} | resetting ${callSLHit ? "call" : "put"}`, "error");
    await executeSLReset(trade, callSLHit ? "call" : "put");
  }
};

// ─── SCAN & SYNC — every 5 seconds ───────────────────────────────────────────
// ─── scanAndSyncOrders ────────────────────────────────────────────────────────
// Runs every 1 second — uses live WebSocket prices (condorPrices{}) only.
// No REST calls here — dashboard gets real-time data from Kite WebSocket feed.
export const scanAndSyncOrders = async () => {
  const ActiveTrade = getActiveTradeModel();
  const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
  if (!trade) return;

  const hasCall    = !!(trade.symbols.callSell && trade.symbols.callBuy && trade.callSpreadEntryPremium > 0);
  const hasPut     = !!(trade.symbols.putSell  && trade.symbols.putBuy  && trade.putSpreadEntryPremium  > 0);
  const callNet    = hasCall ? getCallNet(trade) : 0;
  const putNet     = hasPut  ? getPutNet(trade)  : 0;
  const buffer     = trade.bufferPremium || 0;
  const callEntry  = trade.callSpreadEntryPremium;
  const putEntry   = trade.putSpreadEntryPremium;

  // P&L from live WebSocket prices — no REST needed
  const livePnL = (hasCall ? (callEntry - callNet) : 0) * trade.quantity
                + (hasPut  ? (putEntry  - putNet)  : 0) * trade.quantity;
  const kitePnl = getKitePnL(trade); // uses cached REST data updated by reconcileKitePositions
  const pnl     = kitePnl !== null ? kitePnl : livePnL;

  const io = getIO();
  if (io) {
    io.emit("condor:monitor", {
      index:            trade.index,
      mode:             trade.mode,
      isButterfly:      trade.isIronButterfly,
      slCount:          trade.slCount,
      pnl:              pnl.toFixed(2),
      pnlSource:        kitePnl !== null ? "kite" : "live",
      buffer:           buffer.toFixed(2),
      expiry:           trade.expiry,
      call: {
        sellSymbol:     trade.symbols.callSell,
        buySymbol:      trade.symbols.callBuy,
        entry:          callEntry.toFixed(2),
        current:        callNet.toFixed(2),
        sl:             slLevel(callEntry, buffer).toFixed(2),
        ff3x:           firefightLossLevel(callEntry).toFixed(2),
        ffProfit:       firefightProfitLevel(callEntry).toFixed(2),
      },
      put: {
        sellSymbol:     trade.symbols.putSell,
        buySymbol:      trade.symbols.putBuy,
        entry:          putEntry.toFixed(2),
        current:        putNet.toFixed(2),
        sl:             slLevel(putEntry, buffer).toFixed(2),
        ff3x:           firefightLossLevel(putEntry).toFixed(2),
        ffProfit:       firefightProfitLevel(putEntry).toFixed(2),
      },
      butterflySL:         trade.isIronButterfly ? trade.butterflySL?.toFixed(2) : null,
      firefightPending:    trade.firefightPending    || false,
      firefightSide:       trade.firefightSide       || null,
      butterflyPending:    trade.butterflyPending     || false,
      oppositeSidePending: trade.oppositeSidePending  || false,
      oppositeSide:        trade.oppositeSide         || null,
      positionType:        trade.positionType         || "IRON_CONDOR",
    });
  }

  // SL/FF condition checks — stale feed guard
  if (isFeedStale()) {
    if (!_staleAlertSent) {
      _staleAlertSent = true;
      const hasTrade = await ActiveTrade.findOne({ status: "ACTIVE" }).lean().catch(() => null);
      if (hasTrade) {
        const age = getLastTickAge();
        const msg = age
          ? `🚨 Kite feed STALE (${age}s since last tick) — SL/FF checks PAUSED. Reconnecting…`
          : `🚨 Kite feed DARK — no ticks received yet. SL/FF checks PAUSED.`;
        console.error(msg);
        condorLog(msg, "error");
      }
    }
    return;
  }

  if (!_actionInProgress) {
    _actionInProgress = true;
    try { await _checkConditions(trade); }
    catch (e) { console.error("❌ scanAndSync condition check:", e.message); }
    finally { _actionInProgress = false; }
  }
};

// ─── reconcileKitePositions ───────────────────────────────────────────────────
// Runs every 60 seconds from server.js.
// Two jobs:
//   1. If active trade exists → refresh cached P&L data from Kite REST
//   2. If NO active trade in DB → check if manual positions exist in Kite → auto-import
export const reconcileKitePositions = async () => {
  const ActiveTrade = getActiveTradeModel();
  const trade = await ActiveTrade.findOne({ status: { $in: ["ACTIVE", "EXITING"] } });

  try {
    const kc = getKiteInstance();
    const [pos, orders] = await Promise.all([
      kc.getPositions(),
      kc.getOrders(),
    ]);
    const netPositions = pos?.net || [];
    updateKitePositions(netPositions);
    updateKiteOrders(orders || []);

    // ── Job 1: existing trade — just refresh cache ────────────────────────
    if (trade) {
      console.log("🔄 Kite positions reconciled");
      return;
    }

    // ── Job 2: no active trade — check for manual positions in Kite ───────
    // Skip in paper mode — no real positions exist in Kite
    if (!LIVE()) return;

    // Only run during market hours to avoid ghost detection
    const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const mins = now.getHours() * 60 + now.getMinutes();
    const isMarketHours = now.getDay() >= 1 && now.getDay() <= 5 && mins >= 555 && mins < 930;
    if (!isMarketHours) return;

    // Find open option legs across both exchanges
    const openLegs = netPositions.filter(p =>
      (p.exchange === "NFO" || p.exchange === "BFO") && p.quantity !== 0
    );
    if (openLegs.length === 0) return;

    // Determine index from exchange
    const hasBFO = openLegs.some(p => p.exchange === "BFO");
    const hasNFO = openLegs.some(p => p.exchange === "NFO");

    // Handle one index at a time — if both found take SENSEX first (BFO)
    const exchange = hasBFO ? "BFO" : "NFO";
    const index    = exchange === "BFO" ? "SENSEX" : "NIFTY";
    const legs     = openLegs.filter(p => p.exchange === exchange);

    const callLegs = legs.filter(p => p.tradingsymbol.endsWith("CE"));
    const putLegs  = legs.filter(p => p.tradingsymbol.endsWith("PE"));
    const callSell = callLegs.find(p => p.quantity < 0) || null;
    const callBuy  = callLegs.find(p => p.quantity > 0) || null;
    const putSell  = putLegs.find(p => p.quantity < 0)  || null;
    const putBuy   = putLegs.find(p => p.quantity > 0)  || null;

    // Must have at least one complete spread (sell + buy same type)
    const hasCallSpread = !!(callSell && callBuy);
    const hasPutSpread  = !!(putSell  && putBuy);
    if (!hasCallSpread && !hasPutSpread) return;

    // Quantity from actual Kite position
    const quantity = Math.abs(
      hasCallSpread ? callSell.quantity : putSell.quantity
    );

    // Entry premiums from actual Kite avg prices
    const callEntry = hasCallSpread
      ? Math.max(0, callSell.sell_value / Math.abs(callSell.quantity) - callBuy.buy_value / callBuy.quantity)
      : 0;
    const putEntry = hasPutSpread
      ? Math.max(0, putSell.sell_value / Math.abs(putSell.quantity) - putBuy.buy_value / putBuy.quantity)
      : 0;

    // positionType based on what was found
    const positionType = hasCallSpread && hasPutSpread ? "IRON_CONDOR"
                       : hasCallSpread                 ? "ONE_SIDE_CALL"
                       :                                 "ONE_SIDE_PUT";

    // Subscribe to live prices for all found legs
    const instruments = await kc.getInstruments([exchange]);
    const findToken   = (sym) => instruments.find(i => i.tradingsymbol === sym)?.instrument_token || null;
    if (callSell) cacheAndSubscribe(callSell.tradingsymbol, findToken(callSell.tradingsymbol));
    if (callBuy)  cacheAndSubscribe(callBuy.tradingsymbol,  findToken(callBuy.tradingsymbol));
    if (putSell)  cacheAndSubscribe(putSell.tradingsymbol,  findToken(putSell.tradingsymbol));
    if (putBuy)   cacheAndSubscribe(putBuy.tradingsymbol,   findToken(putBuy.tradingsymbol));

    const expiry = getNearestExpiry(index);
    const mode   = process.env.DEFAULT_MODE || "SEMI_AUTO";

    await ActiveTrade.create({
      index,
      status:                 "ACTIVE",
      mode,
      positionType,
      symbols: {
        callSell: callSell?.tradingsymbol || null,
        callBuy:  callBuy?.tradingsymbol  || null,
        putSell:  putSell?.tradingsymbol  || null,
        putBuy:   putBuy?.tradingsymbol   || null,
      },
      orderIds: { callSell: null, callBuy: null, putSell: null, putBuy: null },
      callSpreadEntryPremium: callEntry,
      putSpreadEntryPremium:  putEntry,
      totalEntryPremium:      callEntry + putEntry,
      quantity,
      expiry,
      bufferPremium:   0,
      slCount:         0,
      isIronButterfly: false,
    });

    await sendCondorAlert(
      `📡 <b>Auto-Detected from Kite</b> · ${index} · ${positionType}
` +
      (hasCallSpread ? `Call: SELL ${callSell.tradingsymbol} / BUY ${callBuy.tradingsymbol} · Net: <b>${callEntry.toFixed(2)}</b>
` : "") +
      (hasPutSpread  ? `Put:  SELL ${putSell.tradingsymbol}  / BUY ${putBuy.tradingsymbol}  · Net: <b>${putEntry.toFixed(2)}</b>
`  : "") +
      `Qty: ${quantity} · Mode: ${mode}
Monitoring started automatically`
    );
    condorLog(`📡 AUTO-DETECTED ${index} | positionType=${positionType} | call=${callEntry.toFixed(2)} put=${putEntry.toFixed(2)} qty=${quantity}`, "success");

  } catch (e) {
    console.error("❌ Kite reconcile error:", e.message);
  }
};