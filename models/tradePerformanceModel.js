import mongoose from 'mongoose';

const tradePerformanceSchema = new mongoose.Schema({
  index: { type: String, required: true },
  exitReason: { type: String, enum: ['STOP_LOSS_HIT', 'ATM_MANUAL_HANDOFF', 'PROFIT_TARGET', 'MANUAL_CLOSE'] },
  realizedPnL: { type: Number, required: true },
  notes: { type: String }
}, { timestamps: true });

export default mongoose.model('TradePerformance', tradePerformanceSchema);