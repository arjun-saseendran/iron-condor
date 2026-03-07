import mongoose from 'mongoose';

const schema = new mongoose.Schema({
    strategy: {
        type: String,
        default: 'IRON_CONDOR',
        enum: ['TRAFFIC_LIGHT', 'IRON_CONDOR'],
    },

    index: { type: String, required: true },

    // Reference to the ActiveTrade this performance record belongs to
    activeTradeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ActiveTrade',
        default: null,
    },

    // ── Exit reason ───────────────────────────────────────────────────────────
    // FIREFIGHT: a spread was rolled inward (partial profit locked, trade continues)
    // Both ironCondorEngine and autoCondorEngine read this to calculate cycle buffer.
    // fetchHistoricalBuffer() sums firefightBookedPnL (or realizedPnL fallback)
    // for FIREFIGHT records — stops summing at first STOP_LOSS_HIT.
    exitReason: {
        type: String,
        enum: [
            'STOP_LOSS_HIT',
            'PROFIT_TARGET',
            'MANUAL_CLOSE',
            'FIREFIGHT',         // ✅ FIX: was missing — engines read and write this value
            'ATM_MANUAL_HANDOFF',
        ],
    },

    realizedPnL: { type: Number, required: true },

    // ── Firefight-specific booked profit ──────────────────────────────────────
    // When a firefight roll is executed, the premium collected on the closed
    // leg minus what was paid to close it = the locked profit from that roll.
    // Stored separately so fetchHistoricalBuffer() can use it precisely
    // instead of relying on a full realizedPnL (which may include open leg value).
    // If null, fetchHistoricalBuffer() falls back to realizedPnL.
    firefightBookedPnL: { type: Number, default: null },  // ✅ FIX: was missing entirely

    notes: { type: String },

}, { timestamps: true });

// Shared 'tradeperformances' collection — strategy field differentiates records
export const getCondorTradePerformanceModel = () => {
    return mongoose.models.TradePerformance ||
        mongoose.model('TradePerformance', schema);
};