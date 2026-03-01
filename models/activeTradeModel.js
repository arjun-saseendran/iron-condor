import mongoose from 'mongoose';

const activeTradeSchema = new mongoose.Schema({
  index: { type: String, required: true }, // NIFTY or SENSEX
  status: { 
    type: String, 
    default: 'ACTIVE', 
    enum: ['ACTIVE', 'MANUAL_OVERRIDE', 'EXITING', 'EXITED', 'FAILED_EXIT'] 
  },
  
  // --- NEW DYNAMIC STATE VARIABLES ---
  isIronButterfly: { type: Boolean, default: false }, // Triggers the 2% SL logic instead of 4x
  bufferPremium: { type: Number, default: 0 }, // Accumulated profit from previous firefight rolls
  lotSize: { type: Number, required: true }, // Loaded dynamically from .env
  
  // --- STRIKES (For ATM Detection) ---
  callSellStrike: { type: Number, required: true },
  putSellStrike: { type: Number, required: true },
  
  // --- PREMIUMS ---
  callSpreadEntryPremium: { type: Number, required: true },
  putSpreadEntryPremium: { type: Number, required: true },
  totalEntryPremium: { type: Number, required: true }, // Used for the Iron Butterfly 2% calculation
  
  // --- ALERT TRACKERS (Prevents spamming) ---
  alertsSent: {
    call70Decay: { type: Boolean, default: false },
    put70Decay: { type: Boolean, default: false },
    firefightAlert: { type: Boolean, default: false }
  },

  // --- KITE SYMBOLS & TOKENS ---
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