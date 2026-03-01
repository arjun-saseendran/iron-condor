import mongoose from 'mongoose';

const activeTradeSchema = new mongoose.Schema({
  index: { type: String, required: true }, // NIFTY or SENSEX
  status: { 
    type: String, 
    default: 'ACTIVE', 
    enum: ['ACTIVE', 'MANUAL_OVERRIDE', 'EXITING', 'EXITED', 'FAILED_EXIT'] 
  },
  
  // --- NEW: Identifies if this is a 4-leg IC or a 2-leg directional spread ---
  tradeType: { 
    type: String, 
    enum: ['IRON_CONDOR', 'CALL_SPREAD', 'PUT_SPREAD'], 
    required: true 
  },
  
  // --- DYNAMIC STATE VARIABLES ---
  isIronButterfly: { type: Boolean, default: false }, 
  bufferPremium: { type: Number, default: 0 }, // Holds booked profits from trending rolls!
  lotSize: { type: Number, required: true }, 
  
  // --- STRIKES (Required flags removed to allow 2-leg trades) ---
  callSellStrike: { type: Number },
  putSellStrike: { type: Number },
  
  // --- PREMIUMS ---
  callSpreadEntryPremium: { type: Number, default: 0 },
  putSpreadEntryPremium: { type: Number, default: 0 },
  totalEntryPremium: { type: Number, required: true },
  
  // --- ALERT TRACKERS ---
  alertsSent: {
    call70Decay: { type: Boolean, default: false },
    put70Decay: { type: Boolean, default: false },
    firefightAlert: { type: Boolean, default: false }
  },

  // --- KITE SYMBOLS & TOKENS ---
  symbols: {
    callSell: { type: String },
    callBuy: { type: String },
    putSell: { type: String },
    putBuy: { type: String }
  },
  tokens: {
    spotIndex: { type: Number, required: true },
    callSell: { type: Number },
    callBuy: { type: Number },
    putSell: { type: Number },
    putBuy: { type: Number }
  }
}, { timestamps: true });

const ActiveTrade = mongoose.model('ActiveTrade', activeTradeSchema);
export default ActiveTrade;