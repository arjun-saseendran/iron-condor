import express from 'express';
import { calculateNetPremium } from '../services/orderMoniterService.js';
import ActiveTrade from '../models/activeTradeModel.js';

const router = express.Router();

router.post('/deploy', async (req, res) => {
  try {
    const { 
      index, 
      callSellStrike, 
      putSellStrike, 
      callSellSymbol, 
      callBuySymbol, 
      putSellSymbol, 
      putBuySymbol,
      tokens,
      bookedCallPremium = 0,
      bookedPutPremium = 0
    } = req.body;

    // 1. Validation for the Strikes
    if (!index || !callSellStrike || !putSellStrike || !tokens) {
      return res.status(400).json({ error: "Missing required fields (Index, Strikes, or Tokens)." });
    }

    console.log(`🚀 [DEPLOY] Syncing ${index} | Monitoring Strikes: ${putSellStrike} - ${callSellStrike}`);

    // 2. Calculate actual entry premiums from Kite
    const callSpreadNet = await calculateNetPremium(callSellSymbol, callBuySymbol);
    const putSpreadNet = await calculateNetPremium(putSellSymbol, putBuySymbol);

    if (callSpreadNet === null || putSpreadNet === null) {
      return res.status(400).json({ error: 'Order data not found on Kite. Check symbols.' });
    }

    // 3. Clear existing entry for this index (Important to wipe MANUAL_OVERRIDE status)
    await ActiveTrade.deleteMany({ index });

    // 4. Create new Active trade (Default status is 'ACTIVE')
    const newTrade = await ActiveTrade.create({
      index,
      status: 'ACTIVE', // Explicitly reset to active
      callSellStrike,
      putSellStrike,
      callSpreadEntryPremium: callSpreadNet,
      putSpreadEntryPremium: putSpreadNet,
      bookedCallPremium, 
      bookedPutPremium,
      tokens,
      symbols: {
        callSell: callSellSymbol,
        callBuy: callBuySymbol,
        putSell: putSellSymbol,
        putBuy: putBuySymbol
      }
    });

    res.status(201).json({ status: 'success', message: `${index} Synced and Monitoring Started!`, trade: newTrade });
  } catch (error) {
    console.error('❌ [DEPLOY ROUTE] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Getter for Postman to check current status
router.get('/active', async (req, res) => {
  try {
    const trades = await ActiveTrade.find({});
    res.status(200).json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;