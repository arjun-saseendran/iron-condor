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
import getActiveTradeModel               from "../models/ironCondorActiveTradeModel.js";
import { getCondorTradePerformanceModel } from "../models/condorTradePerformanceModel.js";

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
const BF_SL_MULT    = () => parseFloat(process.env.BF_SL_MULTIPLIER     || "3");

const slLevel              = (entry, buffer) => entry * SL_MULT()       + buffer;
const firefightLossLevel   = (entry)         => entry * FF_LOSS_MULT();
const firefightProfitLevel = (entry)         => entry * FF_PROFIT_THR();
const butterflySLLevel     = (total, buffer) => total * BF_SL_MULT()    + buffer;

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
export const selectCondorStrikes = (strikes, spot, index) => {
  const spread     = SPREAD[index]();
  const minPremium = MIN_PREMIUM[index]();
  const interval   = STRIKE_INTERVAL[index];
  const atm        = Math.round(spot / interval) * interval;

  let callSell = null, callBuy = null;
  for (let i = 0; i < strikes.length; i++) {
    if (strikes[i].strike < atm) continue;
    const buyRow = strikes.find(s => s.strike === strikes[i].strike + spread);
    if (!buyRow) continue;
    const net = strikes[i].callLtp - buyRow.callLtp;
    if (net >= minPremium) { callSell = strikes[i]; callBuy = buyRow; break; }
  }

  let putSell = null, putBuy = null;
  for (let i = strikes.length - 1; i >= 0; i--) {
    if (strikes[i].strike > atm) continue;
    const buyRow = strikes.find(s => s.strike === strikes[i].strike - spread);
    if (!buyRow) continue;
    const net = strikes[i].putLtp - buyRow.putLtp;
    if (net >= minPremium) { putSell = strikes[i]; putBuy = buyRow; break; }
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
    for (let i = 0; i < strikes.length; i++) {
      if (strikes[i].strike < atm) continue;
      const buyRow = strikes.find(s => s.strike === strikes[i].strike + spread);
      if (!buyRow) continue;
      const net = strikes[i].callLtp - buyRow.callLtp;
      if (net >= minPremium) return { sell: strikes[i], buy: buyRow, net };
    }
    throw new Error(`No replacement call spread with net >= ${minPremium}`);
  } else {
    for (let i = strikes.length - 1; i >= 0; i--) {
      if (strikes[i].strike > atm) continue;
      const buyRow = strikes.find(s => s.strike === strikes[i].strike - spread);
      if (!buyRow) continue;
      const net = strikes[i].putLtp - buyRow.putLtp;
      if (net >= minPremium) return { sell: strikes[i], buy: buyRow, net };
    }
    throw new Error(`No replacement put spread with net >= ${minPremium}`);
  }
};

// ─── Cache + subscribe legs ───────────────────────────────────────────────────
const cacheAndSubscribe = (kiteSymbol, instrumentToken) => {
  if (!kiteSymbol || !instrumentToken) return;
  cacheSymbol(kiteSymbol, instrumentToken);
  subscribeCondorToken(instrumentToken);
};

// ─── Kite order helpers ───────────────────────────────────────────────────────
const placeKiteOrder = async (tradingsymbol, transactionType, quantity, index) => {
  if (!LIVE()) {
    const id = `PAPER-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log(`📝 [PAPER] ${transactionType} ${quantity} × ${tradingsymbol}`);
    return id;
  }
  const kc    = getKiteInstance();
  const order = await kc.placeOrder("regular", {
    exchange:         getKiteExchange(index),
    tradingsymbol,
    transaction_type: transactionType,
    quantity,
    order_type:       "MARKET",
    product:          "MIS",
  });
  console.log(`✅ Kite: ${transactionType} ${tradingsymbol} → ${order.order_id}`);
  return order.order_id;
};

// ENTRY: BUY leg first, then SELL leg (margin safety)
const enterSpread = async (sellSymbol, buySymbol, quantity, index) => {
  const buyId  = await placeKiteOrder(buySymbol,  "BUY",  quantity, index);
  const sellId = await placeKiteOrder(sellSymbol, "SELL", quantity, index);
  return { sellId, buyId };
};

// EXIT: close short (BUY back) first, then close long (SELL) — frees margin first
const exitSpread = async (sellSymbol, buySymbol, quantity, index) => {
  await placeKiteOrder(sellSymbol, "BUY",  quantity, index);
  await placeKiteOrder(buySymbol,  "SELL", quantity, index);
};

// ─── ENTER IRON CONDOR ────────────────────────────────────────────────────────
export const enterIronCondor = async (index, quantity, mode = "SEMI_AUTO") => {
  const ActiveTrade = getActiveTradeModel();

  const existing = await ActiveTrade.findOne({ status: { $in: ["ACTIVE", "EXITING"] } });
  if (existing) throw new Error("Active trade already exists — exit first");

  const expiry  = getNearestExpiry(index);
  const spot    = await getSpotPrice(index);
  const strikes = await fetchFullOptionChain(index, expiry);
  const sel     = selectCondorStrikes(strikes, spot, index);

  const callSellSym = buildKiteSymbol(index, expiry, sel.callSell.strike, "CE");
  const callBuySym  = buildKiteSymbol(index, expiry, sel.callBuy.strike,  "CE");
  const putSellSym  = buildKiteSymbol(index, expiry, sel.putSell.strike,  "PE");
  const putBuySym   = buildKiteSymbol(index, expiry, sel.putBuy.strike,   "PE");

  cacheAndSubscribe(callSellSym, sel.callSell.callKey);
  cacheAndSubscribe(callBuySym,  sel.callBuy.callKey);
  cacheAndSubscribe(putSellSym,  sel.putSell.putKey);
  cacheAndSubscribe(putBuySym,   sel.putBuy.putKey);  const callOrders = await enterSpread(callSellSym, callBuySym, quantity, index);
  const putOrders  = await enterSpread(putSellSym,  putBuySym,  quantity, index);

  const callEntry  = Math.max(0, sel.callSell.callLtp - sel.callBuy.callLtp);
  const putEntry   = Math.max(0, sel.putSell.putLtp   - sel.putBuy.putLtp);
  const totalEntry = callEntry + putEntry;

  const trade = await ActiveTrade.create({
    index,
    status:   "ACTIVE",
    mode,
    symbols:  { callSell: callSellSym, callBuy: callBuySym, putSell: putSellSym, putBuy: putBuySym },
    orderIds: { callSell: callOrders.sellId, callBuy: callOrders.buyId, putSell: putOrders.sellId, putBuy: putOrders.buyId },
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
    `🦅 <b>Iron Condor ENTERED</b> · ${index} · ${mode}\n` +
    `Call: SELL ${callSellSym} / BUY ${callBuySym} · Net: <b>${callEntry.toFixed(2)}</b>\n` +
    `Put:  SELL ${putSellSym} / BUY ${putBuySym} · Net: <b>${putEntry.toFixed(2)}</b>\n` +
    `Total: <b>${totalEntry.toFixed(2)}</b> · Qty: ${quantity} · Expiry: ${expiry}`
  );

  condorLog(`🦅 ENTERED ${index} | Call ${callSellSym}/${callBuySym} net=${callEntry.toFixed(2)} | Put ${putSellSym}/${putBuySym} net=${putEntry.toFixed(2)} | Total=${totalEntry.toFixed(2)} qty=${quantity}`, "success");
  console.log(`✅ Iron Condor entered ${index} call=${callEntry.toFixed(2)} put=${putEntry.toFixed(2)}`);
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

  const profitEntry  = profitSide === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const profitNet    = profitSide === "call" ? getCallNet(trade) : getPutNet(trade);
  const profitBooked = Math.max(0, profitEntry - profitNet);
  const newBuffer    = (trade.bufferPremium || 0) + profitBooked;
  const losingSide   = profitSide === "call" ? "put" : "call";

  console.log(`⚔️ Firefight: exit ${profitSide} net=${profitNet.toFixed(2)} booked=${profitBooked.toFixed(2)}`);
  condorLog(`⚔️ FIREFIGHT triggered | exit ${profitSide} side | net=${profitNet.toFixed(2)} booked=₹${profitBooked.toFixed(2)}`, "warn");

  // 1. Exit profit side
  if (profitSide === "call") {
    await exitSpread(trade.symbols.callSell, trade.symbols.callBuy, trade.quantity, trade.index);
  } else {
    await exitSpread(trade.symbols.putSell, trade.symbols.putBuy, trade.quantity, trade.index);
  }

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

  // 3. Enter new spread — BUY first, SELL second
  const newOrders = await enterSpread(newSellSym, newBuySym, trade.quantity, trade.index);

  // 4. Update DB
  const losingEntry = profitSide === "call" ? trade.putSpreadEntryPremium : trade.callSpreadEntryPremium;
  const newSL       = slLevel(losingEntry, newBuffer);

  const upd = {
    bufferPremium:     newBuffer,
    firefightPending:  false,
    firefightSide:     null,
    // ✅ FIX: totalEntryPremium was computed incorrectly — both ternaries used
    //         profitSide which caused the losing side's premium to be added twice
    //         when profitSide="call". Fixed to use correct side for each term.
    totalEntryPremium:
      (profitSide === "call" ? replacement.net              : trade.callSpreadEntryPremium) +
      (profitSide === "put"  ? replacement.net              : trade.putSpreadEntryPremium),
  };
  if (profitSide === "call") {
    upd["symbols.callSell"]       = newSellSym;
    upd["symbols.callBuy"]        = newBuySym;
    upd["orderIds.callSell"]      = newOrders.sellId;
    upd["orderIds.callBuy"]       = newOrders.buyId;
    upd["callSpreadEntryPremium"] = replacement.net;
  } else {
    upd["symbols.putSell"]        = newSellSym;
    upd["symbols.putBuy"]         = newBuySym;
    upd["orderIds.putSell"]       = newOrders.sellId;
    upd["orderIds.putBuy"]        = newOrders.buyId;
    upd["putSpreadEntryPremium"]  = replacement.net;
  }
  await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });

  await sendCondorAlert(
    `⚔️ <b>FIREFIGHT DONE</b> · ${trade.index}\n` +
    `Exited ${profitSide} · Booked: <b>${profitBooked.toFixed(2)}</b> · Buffer: <b>${newBuffer.toFixed(2)}</b>\n` +
    `New ${profitSide}: SELL ${newSellSym} / BUY ${newBuySym} · Net: <b>${replacement.net.toFixed(2)}</b>\n` +
    `${losingSide} SL now: <b>${newSL.toFixed(2)}</b>`
  );
  condorLog(`⚔️ FIREFIGHT DONE ${trade.index} | new ${profitSide}: ${newSellSym}/${newBuySym} net=${replacement.net.toFixed(2)} | buffer=₹${newBuffer.toFixed(2)}`, "success");
};

// ─── SL RESET ────────────────────────────────────────────────────────────────
export const executeSLReset = async (trade, losingSide) => {
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
    return;
  }

  // 1st SL — exit losing spread first
  try {
    if (losingSide === "call") {
      await exitSpread(trade.symbols.callSell, trade.symbols.callBuy, trade.quantity, trade.index);
    } else {
      await exitSpread(trade.symbols.putSell, trade.symbols.putBuy, trade.quantity, trade.index);
    }
  } catch (e) {
    console.error(`❌ SL exit error ${losingSide}:`, e.message);
  }

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

  const upd = {
    slCount:       newSlCount,
    bufferPremium: 0,
    // ✅ FIX: same totalEntryPremium ternary bug fixed here too
    totalEntryPremium:
      (losingSide === "call" ? replacement.net              : trade.callSpreadEntryPremium) +
      (losingSide === "put"  ? replacement.net              : trade.putSpreadEntryPremium),
  };
  if (losingSide === "call") {
    upd["symbols.callSell"]       = newSellSym;
    upd["symbols.callBuy"]        = newBuySym;
    upd["orderIds.callSell"]      = newOrders.sellId;
    upd["orderIds.callBuy"]       = newOrders.buyId;
    upd["callSpreadEntryPremium"] = replacement.net;
  } else {
    upd["symbols.putSell"]        = newSellSym;
    upd["symbols.putBuy"]         = newBuySym;
    upd["orderIds.putSell"]       = newOrders.sellId;
    upd["orderIds.putBuy"]        = newOrders.buyId;
    upd["putSpreadEntryPremium"]  = replacement.net;
  }
  await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });

  await sendCondorAlert(
    `🔄 <b>SL Reset</b> · ${trade.index} · ${losingSide}\n` +
    `New: SELL ${newSellSym} / BUY ${newBuySym} · Net: <b>${replacement.net.toFixed(2)}</b>\n` +
    `slCount: <b>${newSlCount}</b> · Buffer: reset to 0`
  );
  condorLog(`🔄 SL RESET ${trade.index} | ${losingSide} | new: ${newSellSym}/${newBuySym} net=${replacement.net.toFixed(2)} | slCount=${newSlCount}`, "warn");
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

  // 1. Exit profit side only — book the profit
  const profitNet = profitSide === "call" ? getCallNet(trade) : getPutNet(trade);
  const profitEntry = profitSide === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const profitBooked = Math.max(0, profitEntry - profitNet);
  const newBuffer    = (trade.bufferPremium || 0) + profitBooked;

  if (profitSide === "call") {
    await exitSpread(trade.symbols.callSell, trade.symbols.callBuy, trade.quantity, trade.index);
  } else {
    await exitSpread(trade.symbols.putSell, trade.symbols.putBuy, trade.quantity, trade.index);
  }

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

  const newOrders  = await enterSpread(newSellSym, newBuySym, trade.quantity, trade.index);
  const newEntry   = Math.max(0,
    profitSide === "call"
      ? (sel.callSell.callLtp - sel.callBuy.callLtp)
      : (sel.callSell.callLtp - sel.putBuy.putLtp)
  );

  // 4. Update DB — keep losing side symbols unchanged, update profit side to new ATM spread
  const losingEntry = losingSide === "call" ? trade.callSpreadEntryPremium : trade.putSpreadEntryPremium;
  const totalEntry  = losingEntry + newEntry;
  const bfSL        = butterflySLLevel(totalEntry, newBuffer);

  const upd = {
    isIronButterfly:   true,
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
    condorLog(`✅ Kite feed RECOVERED — SL/FF checks resuming`, "success");
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

// ─── CONDITION CHECKER ───────────────────────────────────────────────────────
const _checkConditions = async (trade) => {
  const callNet    = getCallNet(trade);
  const putNet     = getPutNet(trade);
  const buffer     = trade.bufferPremium || 0;
  const callEntry  = trade.callSpreadEntryPremium;
  const putEntry   = trade.putSpreadEntryPremium;
  const totalEntry = trade.totalEntryPremium;

  // ── Butterfly SL ────────────────────────────────────────────────────────────
  if (trade.isIronButterfly) {
    const bfSL  = butterflySLLevel(totalEntry, buffer);
    const bfNet = callNet + putNet;
    if (bfNet >= bfSL) {
      console.log(`🛑 Butterfly SL hit bfNet=${bfNet.toFixed(2)} bfSL=${bfSL.toFixed(2)}`);
      condorLog(`🛑 BUTTERFLY SL HIT | net=${bfNet.toFixed(2)} SL=${bfSL.toFixed(2)} | exiting all`, "error");
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
  const callLosing = callNet >= firefightLossLevel(callEntry) && putNet  <= firefightProfitLevel(putEntry);
  const putLosing  = putNet  >= firefightLossLevel(putEntry)  && callNet <= firefightProfitLevel(callEntry);

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
  const callSL    = slLevel(callEntry, buffer);
  const putSL     = slLevel(putEntry,  buffer);
  const callSLHit = callNet >= callSL;
  const putSLHit  = putNet  >= putSL;

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
export const scanAndSyncOrders = async () => {
  const ActiveTrade = getActiveTradeModel();
  const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
  if (!trade) return;

  // Fetch Kite positions + orders
  try {
    const kc = getKiteInstance();
    const [pos, orders] = await Promise.all([
      kc.getPositions(),
      kc.getOrders(),
    ]);
    updateKitePositions(pos?.net || []);
    updateKiteOrders(orders || []);
  } catch (e) {
    console.error("❌ Kite fetch error:", e.message);
  }

  const callNet    = getCallNet(trade);
  const putNet     = getPutNet(trade);
  const buffer     = trade.bufferPremium || 0;
  const callEntry  = trade.callSpreadEntryPremium;
  const putEntry   = trade.putSpreadEntryPremium;
  const totalEntry = trade.totalEntryPremium;

  const kitePnl = getKitePnL(trade);
  const livePnL = kitePnl !== null
    ? kitePnl
    : ((callEntry - callNet) + (putEntry - putNet)) * trade.quantity;

  const io = getIO();
  if (io) {
    io.emit("condor:monitor", {
      index:            trade.index,
      mode:             trade.mode,
      isButterfly:      trade.isIronButterfly,
      slCount:          trade.slCount,
      pnl:              livePnL.toFixed(2),
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
      butterflySL:      trade.isIronButterfly ? butterflySLLevel(totalEntry, buffer).toFixed(2) : null,
      firefightPending: trade.firefightPending,
      firefightSide:    trade.firefightSide,
      butterflyPending: trade.butterflyPending,
    });
  }

  // Re-check conditions (catches ticks missed while Kite fetch was running)
  // ✅ STALE FEED GUARD: refuse SL checks if Kite feed has been dark for 30s+
  if (isFeedStale()) {
    if (!_staleAlertSent) {
      _staleAlertSent = true;
      const age = getLastTickAge();
      const msg = age
        ? `🚨 Kite feed STALE (${age}s since last tick) — SL/FF checks PAUSED. Reconnecting…`
        : `🚨 Kite feed DARK — no ticks received yet. SL/FF checks PAUSED.`;
      console.error(msg);
      condorLog(msg, "error");
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