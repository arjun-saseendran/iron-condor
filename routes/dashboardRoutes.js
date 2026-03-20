// ─── Condor Dashboard Routes ──────────────────────────────────────────────────
// Serves live position data for the UI dashboard
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import getActiveTradeModel from "../models/activeTradeModel.js";
import { getCondorTradePerformanceModel } from "../models/tradePerformanceModel.js";
import { condorPrices, getKitePnL } from "../Engines/ironCondorEngine.js";
import { kiteSymbolToToken } from "../services/kiteSymbolMapper.js";

const router = express.Router();

// ✅ FIX: read multipliers from .env — same source as ironCondorEngine.
//         Previously hardcoded (* 4, * 3, * 0.30) so dashboard showed wrong
//         SL/FF levels if .env values were tuned.
const SL_MULT         = () => parseFloat(process.env.SL_MULTIPLIER        || "4");
const FF_LOSS_MULT    = () => parseFloat(process.env.FF_LOSS_MULTIPLIER    || "3");
const FF_PROFIT_THR   = () => parseFloat(process.env.FF_PROFIT_THRESHOLD   || "0.30");
const BF_SL_MULT      = () => parseFloat(process.env.BF_SL_MULTIPLIER      || "3");
const PROFIT_LOCK_THR = () => parseFloat(process.env.PROFIT_LOCK_THRESHOLD || "0.20");

// GET /api/condor/positions
router.get("/positions", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    const CondorPerf  = getCondorTradePerformanceModel();

    const trade = await ActiveTrade.findOne({ status: "ACTIVE" });

    if (!trade) {
      // Return last completed trade summary
      const last = await ActiveTrade.findOne({ status: "COMPLETED" }).sort({ updatedAt: -1 });
      if (!last) return res.json(null);
      const perf = await CondorPerf.findOne({ activeTradeId: last._id });
      return res.json({
        status:     "COMPLETED",
        index:      last.index,
        pnl:        perf?.realizedPnL?.toFixed(2) || "0.00",
        exitReason: perf?.exitReason || "COMPLETED",
      });
    }

    const getLtp = (sym) => {
      if (!sym) return 0;
      const key = kiteSymbolToToken(sym);
      return key ? (condorPrices[key] || 0) : 0;
    };

    const callNet    = Math.max(0, getLtp(trade.symbols.callSell) - getLtp(trade.symbols.callBuy));
    const putNet     = Math.max(0, getLtp(trade.symbols.putSell)  - getLtp(trade.symbols.putBuy));
    const buffer     = trade.bufferPremium || 0;
    const callEntry  = trade.callSpreadEntryPremium;
    const putEntry   = trade.putSpreadEntryPremium;
    const totalEntry = trade.totalEntryPremium;

    // Prefer Kite P&L
    const kitePnl    = getKitePnL(trade);
    const slLoss     = trade.slBookedLoss || 0; // ✅ NEW: loss booked from previous SL exits
    const livePnl    = ((callEntry - callNet) + (putEntry - putNet)) * trade.quantity;
    // Net P&L = current spread profit − already booked SL losses
    const pnl        = kitePnl !== null
      ? kitePnl           // Kite REST gives true settled P&L including SL losses
      : livePnl - slLoss; // Estimated: current profit minus SL losses

    res.json({
      status:      "ACTIVE",
      index:       trade.index,
      mode:        trade.mode,
      expiry:      trade.expiry,
      slCount:     trade.slCount,
      isButterfly: trade.isIronButterfly,
      pnl:         pnl.toFixed(2),
      pnlSource:   kitePnl !== null ? "kite" : "live",
      buffer:      buffer.toFixed(2),
      firefightPending:    trade.firefightPending,
      firefightSide:       trade.firefightSide,
      butterflyPending:    trade.butterflyPending,
      postSlFirefightDone: trade.postSlFirefightDone || false,
      slBookedLoss:        slLoss.toFixed(2),
      profitLockPending:   trade.profitLockPending   || false,
      profitLockSide:      trade.profitLockSide      || null,
      call: {
        sellSymbol:  trade.symbols.callSell,
        buySymbol:   trade.symbols.callBuy,
        entry:       callEntry.toFixed(2),
        current:     callNet.toFixed(2),
        sl:          (callEntry * SL_MULT() + buffer).toFixed(2),
        ff3x:        (callEntry * FF_LOSS_MULT()).toFixed(2),
        ffProfit:    (callEntry * FF_PROFIT_THR()).toFixed(2),
        profitLock:  (callEntry * PROFIT_LOCK_THR()).toFixed(2),
      },
      put: {
        sellSymbol:  trade.symbols.putSell,
        buySymbol:   trade.symbols.putBuy,
        entry:       putEntry.toFixed(2),
        current:     putNet.toFixed(2),
        sl:          (putEntry * SL_MULT() + buffer).toFixed(2),
        ff3x:        (putEntry * FF_LOSS_MULT()).toFixed(2),
        ffProfit:    (putEntry * FF_PROFIT_THR()).toFixed(2),
        profitLock:  (putEntry * PROFIT_LOCK_THR()).toFixed(2),
      },
      butterflySL: trade.isIronButterfly
        ? (totalEntry * BF_SL_MULT() + buffer).toFixed(2)
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;