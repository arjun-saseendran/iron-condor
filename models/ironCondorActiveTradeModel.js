import mongoose from "mongoose";

const activeTradeSchema = new mongoose.Schema(
    {
        index: { type: String, required: true },
        strategy: { type: String, default: 'IRON_CONDOR', enum: ['IRON_CONDOR'] },

        status: {
            type: String,
            default: "ACTIVE",
            enum: ["ACTIVE", "MANUAL_OVERRIDE", "EXITING", "EXITED", "FAILED_EXIT", "COMPLETED"],
        },

        tradeType: {
            type: String,
            enum: ["IRON_CONDOR", "CALL_SPREAD", "PUT_SPREAD"],
            required: true,
        },

        isIronButterfly: { type: Boolean, default: false },
        isAutoMode:      { type: Boolean, default: false },

        // ── Premium tracking ──────────────────────────────────────────────────
        bufferPremium:          { type: Number, default: 0 },
        lotSize:                { type: Number, required: true },
        callSpreadEntryPremium: { type: Number, default: 0 },
        putSpreadEntryPremium:  { type: Number, default: 0 },
        totalEntryPremium:      { type: Number, required: true },

        // ── Circle & SL tracking (used by ironCondorEngine + autoCondorEngine) ─
        // circleNumber: which Iron Condor attempt this is (1 = first, 2 = after 1st SL, etc.)
        // Determined at creation by counting STOP_LOSS_HIT records in TradePerformance
        circleNumber: { type: Number, default: 1 },

        // spreadSLCount: how many spread SLs have fired within this circle (0, 1, or 2)
        // 0 = none hit yet
        // 1 = one side exited (RESET — other side still open, new spread re-entered on Kite)
        // 2 = both sides hit → full exit, circle ends
        spreadSLCount: { type: Number, default: 0 },

        // slHitSide: which side triggered the last SL ('CALL', 'PUT', 'BOTH', or null)
        // Written at exit time by the engine; used to alert trader which spread to re-enter
        slHitSide: { type: String, enum: ['CALL', 'PUT', 'BOTH', null], default: null },

        // exitTime: timestamp when the trade was completed/exited
        exitTime: { type: Date, default: null },

        // ── Alerts sent (prevents duplicate notifications) ─────────────────────
        alertsSent: {
            call70Decay:       { type: Boolean, default: false },
            put70Decay:        { type: Boolean, default: false },
            firefightAlert:    { type: Boolean, default: false },
            callDefense:       { type: Boolean, default: false },
            putDefense:        { type: Boolean, default: false },
            gapAlert:          { type: Boolean, default: false },
            // butterflyAtmAlert: spot has reached short strike, waiting for SL confirm
            // Used by autoCondorEngine before executing butterfly conversion
            butterflyAtmAlert: { type: Boolean, default: false },
        },

        // ── Kite symbols (Kite format, e.g. NIFTY24500CE) ─────────────────────
        symbols: {
            callSell: { type: String, default: null },
            callBuy:  { type: String, default: null },
            putSell:  { type: String, default: null },
            putBuy:   { type: String, default: null },
        },

        // ── Instrument tokens ─────────────────────────────────────────────────
        tokens: {
            spotIndex: { type: Number, required: true },
            callSell:  { type: Number, default: null },
            callBuy:   { type: Number, default: null },
            putSell:   { type: Number, default: null },
            putBuy:    { type: Number, default: null },
        },
    },
    { timestamps: true },
);

const getActiveTradeModel = () => {
    return mongoose.models.ActiveTrade ||
        mongoose.model("ActiveTrade", activeTradeSchema);
};

export default getActiveTradeModel;