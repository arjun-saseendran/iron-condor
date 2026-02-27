import express from 'express';
import { autoFetchAndCalculate } from '../services/orderMoniterService.js';
import ActiveTrade from '../models/activeTradeModel.js';
import { lastPrices } from '../services/tickerService.js';

const router = express.Router();

// ==========================================
// 1. GET ACTIVE TRADES (Live P&L)
// ==========================================
router.get('/active', async (req, res) => {
  try {
    const trades = await ActiveTrade.find({});
    
    const liveStats = trades.map(trade => {
      const { tokens, callSpreadEntryPremium, putSpreadEntryPremium, bookedCallPremium, bookedPutPremium } = trade;

      const cp_sell = lastPrices[tokens.callSell] || 0;
      const cp_buy = lastPrices[tokens.callBuy] || 0;
      const pp_sell = lastPrices[tokens.putSell] || 0;
      const pp_buy = lastPrices[tokens.putBuy] || 0;

      const currentCallNet = cp_buy - cp_sell;
      const currentPutNet = pp_buy - pp_sell;

      const callSL = (Math.abs(callSpreadEntryPremium) * 4) + bookedCallPremium + bookedPutPremium;
      const putSL = (Math.abs(putSpreadEntryPremium) * 4) + bookedCallPremium + bookedPutPremium;

      return {
        ...trade._doc,
        live: {
          call: {
            currentLTP: Math.abs(currentCallNet).toFixed(2),
            stopLoss: callSL.toFixed(2),
            distance: (callSL - Math.abs(currentCallNet)).toFixed(2)
          },
          put: {
            currentLTP: Math.abs(currentPutNet).toFixed(2),
            stopLoss: putSL.toFixed(2),
            distance: (putSL - Math.abs(currentPutNet)).toFixed(2)
          },
          totalPnL: (
            (Math.abs(callSpreadEntryPremium) - Math.abs(currentCallNet)) + 
            (Math.abs(putSpreadEntryPremium) - Math.abs(currentPutNet))
          ).toFixed(2)
        }
      };
    });

    res.status(200).json(liveStats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. DEPLOY (The Zero-Manual Sync)
// ==========================================
router.post('/deploy', async (req, res) => {
  try {
    const { index, bookedCallPremium = 0, bookedPutPremium = 0 } = req.body;

    // VALIDATION: We only need the Index now!
    if (!index) {
      return res.status(400).json({ error: "Please provide index (NIFTY or SENSEX)" });
    }

    console.log(`🚀 [DEPLOY] Auto-fetching last 4 ${index} orders...`);

    // Use the Detective to find everything from Kite
    const tradeData = await autoFetchAndCalculate(index);

    if (!tradeData) {
      return res.status(400).json({ 
        error: `Could not find 4 completed orders for ${index}. Make sure your Iron Condor is filled.` 
      });
    }

    // Clear old trade and save new one
    await ActiveTrade.deleteMany({ index });
    const newTrade = await ActiveTrade.create({
      ...tradeData,
      bookedCallPremium,
      bookedPutPremium,
      status: 'ACTIVE'
    });

    res.status(201).json({ 
      status: 'success', 
      message: `${index} Synced Automatically!`, 
      trade: newTrade 
    });

  } catch (error) {
    console.error('❌ [DEPLOY ERROR]:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;