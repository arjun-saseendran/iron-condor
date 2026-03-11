import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    index:  { type: String, enum: ["NIFTY", "SENSEX"], required: true },
    status: { type: String, enum: ["ACTIVE", "EXITING", "COMPLETED"], default: "ACTIVE" },
    mode:   { type: String, enum: ["SEMI_AUTO", "FULL_AUTO"], default: "SEMI_AUTO" },

    symbols: {
      callSell: String,
      callBuy:  String,
      putSell:  String,
      putBuy:   String,
    },

    orderIds: {
      callSell: String,
      callBuy:  String,
      putSell:  String,
      putBuy:   String,
    },

    callSpreadEntryPremium: { type: Number, default: 0 },
    putSpreadEntryPremium:  { type: Number, default: 0 },
    totalEntryPremium:      { type: Number, default: 0 },

    quantity:        { type: Number, required: true },
    expiry:          { type: String },
    bufferPremium:   { type: Number, default: 0 },
    slCount:         { type: Number, default: 0 },
    isIronButterfly: { type: Boolean, default: false },

    // Semi-auto UI flags
    firefightPending: { type: Boolean, default: false },
    butterflyPending: { type: Boolean, default: false },
    firefightSide:    { type: String, default: null },
    // ✅ FIX: butterflySide stores which side triggered butterfly conversion (sideAtATM).
    //         server.js butterfly route reads this to pass losingSide to convertToButterfly.
    butterflySide:    { type: String, default: null },

    // ✅ NEW: after slCount=1, track if single-side firefight on profit side was done.
    //         false = watch for profit side 70% decay alone (no need for losing side 3x)
    //         true  = post-SL firefight done, resume normal dual-condition FF rules
    postSlFirefightDone: { type: Boolean, default: false },

    // ✅ NEW: cumulative loss booked from SL exits (display only — never used in core logic)
    //         Captured at SL moment = losing spread live net × quantity
    //         Used only by dashboard to show accurate net P&L
    slBookedLoss: { type: Number, default: 0 },

    enteredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

let _model = null;
const getActiveTradeModel = () => {
  if (!_model) _model = mongoose.model("IronCondorActiveTrade", schema);
  return _model;
};
export default getActiveTradeModel;