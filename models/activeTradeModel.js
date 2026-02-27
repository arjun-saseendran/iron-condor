import mongoose from 'mongoose';

const activeTradeSchema = new mongoose.Schema({
  index: { type: String, required: true }, // NIFTY or SENSEX
  status: { 
    type: String, 
    default: 'ACTIVE', 
    enum: ['ACTIVE', 'MANUAL_OVERRIDE', 'EXITING', 'EXITED', 'FAILED_EXIT'] 
  },
  callSellStrike: { type: Number, required: true }, // The strike the bot watches for Killswitch
  putSellStrike: { type: Number, required: true },  // The strike the bot watches for Killswitch
  callSpreadEntryPremium: { type: Number, required: true },
  putSpreadEntryPremium: { type: Number, required: true },
  bookedCallPremium: { type: Number, default: 0 },
  bookedPutPremium: { type: Number, default: 0 },
  symbols: {
    callSell: { type: String, required: true },
    callBuy: { type: String, required: true },
    putSell: { type: String, required: true },
    putBuy: { type: String, required: true }
  },
  tokens: {
    spotIndex: { type: Number, required: true },
    callSell: { type: Number, required: true },
    callBuy: { type: Number, required: true },
    putSell: { type: Number, required: true },
    putBuy: { type: Number, required: true }
  }
}, { timestamps: true });

const ActiveTrade = mongoose.model('ActiveTrade', activeTradeSchema);
export default ActiveTrade;