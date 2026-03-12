import mongoose from "mongoose";

// ─── Condor Trade Performance Schema ─────────────────────────────────────────
// Written once per closed trade.  Referenced by /api/history and
// /api/condor/positions (for COMPLETED status display).
// ─────────────────────────────────────────────────────────────────────────────

const condorTradePerformanceSchema = new mongoose.Schema(
  {
    strategy:    { type: String, default: "IRON_CONDOR" },
    activeTradeId: { type: mongoose.Schema.Types.ObjectId, ref: "IronCondorActiveTrade" },

    index:       { type: String, enum: ["NIFTY", "SENSEX"] },

    // ── PnL ───────────────────────────────────────────────────────────────────
    realizedPnL: { type: Number, default: 0 },

    // ── Exit metadata ─────────────────────────────────────────────────────────
    exitReason: {
      type: String,
      enum: [
        "TARGET_HIT",
        "CALL_SL",
        "PUT_SL",
        "BOTH_SL",
        "MANUAL_EXIT",
        "EXPIRY",
        "FIREFIGHT_EXIT",
        "COMPLETED",
        "BUTTERFLY_SL",   // ✅ FIX: used in ironCondorEngine _checkConditions butterfly SL path
        "GAP_OPEN_HOLD",  // ✅ FIX: used in autoCondorEngine checkGapOpen exit path
      ],
    },

    notes: { type: String },
  },
  { timestamps: true }
);

let _model = null;
export const getCondorTradePerformanceModel = () => {
  if (!_model) _model = mongoose.model("CondorTradePerformance", condorTradePerformanceSchema);
  return _model;
};