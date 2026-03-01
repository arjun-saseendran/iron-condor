import express from 'express';
import { scanAndSyncOrders } from '../services/orderMonitorService.js';
import ActiveTrade from '../models/activeTradeModel.js';
import { lastPrices } from '../services/tickerService.js';

const router = express.Router();

// ==========================================
// 1. GET ACTIVE TRADES (Live P&L & Distance to SL)
// ==========================================
router.get('/active', async (req, res) => {
  try {
    const trades = await ActiveTrade.find({});
    
    const liveStats = trades.map(trade => {
      const { tokens, callSpreadEntryPremium, putSpreadEntryPremium, totalEntryPremium, bufferPremium, isIronButterfly } = trade;

      // Ensure we have prices, default to 0 if ticker hasn't fetched yet
      const cp_sell = lastPrices[tokens.callSell] || 0;
      const cp_buy = lastPrices[tokens.callBuy] || 0;
      const pp_sell = lastPrices[tokens.putSell] || 0;
      const pp_buy = lastPrices[tokens.putBuy] || 0;

      // Current cost to close the spreads
      const currentCallNet = Math.abs(cp_buy - cp_sell);
      const currentPutNet = Math.abs(pp_buy - pp_sell);
      const totalCurrentValue = currentCallNet + currentPutNet;

      // Risk Parameters
      let riskStatus = {};

      if (isIronButterfly) {
        // 🦋 2% Iron Butterfly Logic
        const maxLossThreshold = totalEntryPremium * 2;
        const currentLoss = totalCurrentValue - totalEntryPremium;
        
        riskStatus = {
          mode: 'IRON_BUTTERFLY',
          globalSL: maxLossThreshold.toFixed(2),
          currentLoss: currentLoss.toFixed(2),
          distanceToSL: (maxLossThreshold - currentLoss).toFixed(2)
        };
      } else {
        // 🦅 Standard Iron Condor Logic (4x + Buffer)
        const callSL = (callSpreadEntryPremium * 4) + bufferPremium;
        const putSL = (putSpreadEntryPremium * 4) + bufferPremium;

        riskStatus = {
          mode: 'STANDARD_CONDOR',
          call: {
            currentNet: currentCallNet.toFixed(2),
            stopLoss: callSL.toFixed(2),
            distanceToSL: (callSL - currentCallNet).toFixed(2)
          },
          put: {
            currentNet: currentPutNet.toFixed(2),
            stopLoss: putSL.toFixed(2),
            distanceToSL: (putSL - currentPutNet).toFixed(2)
          }
        };
      }

      return {
        ...trade._doc,
        liveRisk: riskStatus,
        totalPnL: (totalEntryPremium - totalCurrentValue).toFixed(2)
      };
    });

    res.status(200).json(liveStats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. FORCE SYNC (Manual Override)
// ==========================================
// Instead of deploying, we just force the Detective to scan your Kite orders right now
router.post('/sync', async (req, res) => {
  try {
    console.log(`🚀 [MANUAL SYNC] Forcing order scanner...`);
    
    await scanAndSyncOrders(); // Calls the new zero-manual function
    const activeTrade = await ActiveTrade.findOne({ status: 'ACTIVE' });

    if (!activeTrade) {
      return res.status(400).json({ 
        error: `Could not find a complete Iron Condor for today. Ensure your orders are filled.` 
      });
    }

    res.status(200).json({ 
      status: 'success', 
      message: `Sync successful! System is monitoring.`, 
      trade: activeTrade 
    });

  } catch (error) {
    console.error('❌ [SYNC ERROR]:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;