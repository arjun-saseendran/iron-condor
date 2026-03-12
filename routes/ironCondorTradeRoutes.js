import express from "express";
import getActiveTradeModel from "../models/activeTradeModel.js";
import { enterIronCondor, exitAllLegs, fetchFullOptionChain, getSpotPrice, getNearestExpiry, selectCondorStrikes } from "../Engines/ironCondorEngine.js";

const router = express.Router();

// POST /api/trades/enter
// Body: { index: "NIFTY"|"SENSEX", quantity: 65, mode: "SEMI_AUTO"|"FULL_AUTO" }
router.post("/enter", async (req, res) => {
  try {
    const { index = "NIFTY", quantity, mode = "SEMI_AUTO" } = req.body;
    if (!["NIFTY","SENSEX"].includes(index))
      return res.status(400).json({ error: "index must be NIFTY or SENSEX" });
    if (!["SEMI_AUTO","FULL_AUTO"].includes(mode))
      return res.status(400).json({ error: "mode must be SEMI_AUTO or FULL_AUTO" });

    const qty = parseInt(quantity || process.env.DEFAULT_TRADE_QUANTITY || "65");
    const trade = await enterIronCondor(index, qty, mode);
    res.json({ success: true, tradeId: trade._id });
  } catch (err) {
    console.error("❌ /api/trades/enter:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/trades/exit
router.post("/exit", async (req, res) => {
  try {
    const { reason = "MANUAL_EXIT" } = req.body;
    const ActiveTrade = getActiveTradeModel();
    const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!trade) return res.status(404).json({ error: "No active trade" });
    await exitAllLegs(trade, reason);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades/active
router.get("/active", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    res.json(await ActiveTrade.findOne({ status: "ACTIVE" }) || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades/preview?index=NIFTY — preview strikes without placing orders
router.get("/preview", async (req, res) => {
  try {
    const index = (req.query.index || "NIFTY").toUpperCase();
    if (!["NIFTY","SENSEX"].includes(index))
      return res.status(400).json({ error: "index must be NIFTY or SENSEX" });

    const expiry  = getNearestExpiry(index);
    const spot    = await getSpotPrice(index);
    const strikes = await fetchFullOptionChain(index, expiry);
    let selected  = null;
    try { selected = selectCondorStrikes(strikes, spot, index); } catch (_) {}

    res.json({
      index, expiry, spot,
      callSell: selected ? { strike: selected.callSell.strike, ltp: selected.callSell.callLtp } : null,
      callBuy:  selected ? { strike: selected.callBuy.strike,  ltp: selected.callBuy.callLtp }  : null,
      putSell:  selected ? { strike: selected.putSell.strike,  ltp: selected.putSell.putLtp }   : null,
      putBuy:   selected ? { strike: selected.putBuy.strike,   ltp: selected.putBuy.putLtp }    : null,
      callNet:  selected ? +(selected.callSell.callLtp - selected.callBuy.callLtp).toFixed(2) : 0,
      putNet:   selected ? +(selected.putSell.putLtp   - selected.putBuy.putLtp).toFixed(2)  : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;