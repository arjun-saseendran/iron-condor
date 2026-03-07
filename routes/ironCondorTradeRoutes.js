import express from 'express';
import { scanAndSyncOrders, condorPrices } from '../Engines/ironCondorEngine.js';
// ✅ FIX: was importing default ActiveTrade — engine uses a lazy getter, use it the same way
import getActiveTradeModel from '../models/ironCondorActiveTradeModel.js';
import { getKiteInstance } from '../config/kiteConfig.js';
// ✅ FIX: was importing sendTelegramAlert — correct name is sendCondorAlert
import { sendCondorAlert } from '../services/telegramService.js';
// ✅ FIX: was importing kiteToFyersSymbol from fyersSymbolMapper — engine uses Upstox
import { kiteToUpstoxSymbol } from '../services/upstoxSymbolMapper.js';

const router = express.Router();

// Lazy getter — same pattern as engine
const ActiveTrade = () => getActiveTradeModel();

// Spread distance per index (mirrors engine config)
const getSpreadDistance = (index) =>
  index === 'SENSEX'
    ? parseInt(process.env.SENSEX_SPREAD_DISTANCE || '500')
    : parseInt(process.env.NIFTY_SPREAD_DISTANCE  || '150');

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET ACTIVE TRADES (DASHBOARD)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/active', async (req, res) => {
  try {
    const trades = await ActiveTrade().find({ status: 'ACTIVE' });

    const kc = getKiteInstance();
    let netPositions = [];
    try {
      if (kc.access_token) {
        const posResponse = await kc.getPositions();
        netPositions = posResponse.net || [];
      }
    } catch (err) {
      console.error('⚠️ Could not fetch Kite positions for Live P&L:', err.message);
    }

    const liveStats = trades.map(trade => {
      const {
        symbols,
        callSpreadEntryPremium,
        putSpreadEntryPremium,
        bufferPremium,
        tradeType,
        index,
        isIronButterfly,
        totalEntryPremium,
      } = trade;

      // ✅ FIX: use kiteToUpstoxSymbol (not kiteToFyersSymbol) — engine is on Upstox
      const getLtp = (sym) => sym ? condorPrices[kiteToUpstoxSymbol(sym, index)] || 0 : 0;

      const currentCallNet = tradeType !== 'PUT_SPREAD' && symbols.callSell
        ? Math.abs(getLtp(symbols.callSell) - getLtp(symbols.callBuy)) : 0;
      const currentPutNet = tradeType !== 'CALL_SPREAD' && symbols.putSell
        ? Math.abs(getLtp(symbols.putSell) - getLtp(symbols.putBuy)) : 0;

      const indexPositions = netPositions.filter(
        p => p.tradingsymbol && p.tradingsymbol.startsWith(index)
      );
      const liveKitePnL = indexPositions.reduce((sum, p) => sum + p.pnl, 0);

      const callSellPos = indexPositions.find(p => p.tradingsymbol === symbols.callSell);
      const putSellPos  = indexPositions.find(p => p.tradingsymbol === symbols.putSell);
      const currentQty  = Math.abs(callSellPos?.quantity || putSellPos?.quantity || 0);

      // ✅ FIX: apply the same spread/2 cap as the engine — raw SL could exceed spread width
      const spread     = getSpreadDistance(index);
      const maxSpreadSL = spread / 2;
      const rawCallSL  = (callSpreadEntryPremium * 4) + bufferPremium;
      const rawPutSL   = (putSpreadEntryPremium  * 4) + bufferPremium;
      const callSL     = Math.min(rawCallSL, maxSpreadSL);
      const putSL      = Math.min(rawPutSL,  maxSpreadSL);

      // Iron Butterfly SL uses original IC total premium × 3
      const butterflySL = (totalEntryPremium * 3) + bufferPremium;

      return {
        index,
        totalPnL:        liveKitePnL.toFixed(2),
        quantity:        currentQty,
        bufferPremium,
        isIronButterfly,
        spreadSLCount:   trade.spreadSLCount || 0,
        circleNumber:    trade.circleNumber   || 1,
        call: {
          entry:          callSpreadEntryPremium.toFixed(2),
          current:        currentCallNet.toFixed(2),
          sl:             callSL.toFixed(2),
          // ✅ FIX: renamed from 'firefight' (misleading) to 'firefightLevel'
          //         this is the price level at which the firefight banner fires (30% of entry)
          firefightLevel: (callSpreadEntryPremium * 0.3).toFixed(2),
          booked:         bufferPremium.toFixed(2),
        },
        put: {
          entry:          putSpreadEntryPremium.toFixed(2),
          current:        currentPutNet.toFixed(2),
          sl:             putSL.toFixed(2),
          firefightLevel: (putSpreadEntryPremium * 0.3).toFixed(2),
          booked:         bufferPremium.toFixed(2),
        },
        // Butterfly SL shown separately — only relevant after conversion
        butterflySL: butterflySL.toFixed(2),
      };
    });

    res.status(200).json(liveStats);
  } catch (error) {
    console.error('❌ API Active Trades Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MANUAL SYNC
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    await scanAndSyncOrders();
    const activeTrade = await ActiveTrade().findOne({ status: 'ACTIVE' });
    res.status(200).json({ status: 'success', trade: activeTrade });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 1-CLICK ROLL EXECUTION
// Body: { rollData: { side, sellSymbol, buySymbol } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/execute-roll', async (req, res) => {
  try {
    const { rollData } = req.body;
    const trade = await ActiveTrade().findOne({ status: 'ACTIVE' });
    if (!trade || !rollData) return res.status(400).json({ error: 'Missing data' });

    const kc       = getKiteInstance();
    const exchange = trade.index === 'SENSEX' ? 'BFO' : 'NFO';
    const qty      = trade.lotSize;

    const oldShort = rollData.side === 'CE' ? trade.symbols.callSell : trade.symbols.putSell;
    const oldLong  = rollData.side === 'CE' ? trade.symbols.callBuy  : trade.symbols.putBuy;

    // ✅ FIX: correct margin-safe sequence:
    //   Step 1 — Buy back old short FIRST (immediately frees margin)
    //   Step 2 — Sell old long (closes the hedge)
    //   Step 3 — Buy new long (re-establishes hedge before selling)
    //   Step 4 — Sell new short (new position, margin already covered by step 3)
    const order = (sym, txn) => kc.placeOrder('regular', {
      exchange,
      tradingsymbol:    sym,
      transaction_type: txn,
      quantity:         qty,
      order_type:       'MARKET',
      product:          'NRML',
    });

    await order(oldShort,          'BUY');   // Step 1: buy back old short
    await order(oldLong,           'SELL');  // Step 2: sell old long
    await order(rollData.buySymbol, 'BUY');  // Step 3: buy new long
    await order(rollData.sellSymbol,'SELL'); // Step 4: sell new short

    // ✅ FIX: update the correct side's symbols AND entry premium
    //         without updating entryPremium, SL levels become stale after roll
    if (rollData.side === 'CE') {
      trade.symbols.callSell          = rollData.sellSymbol;
      trade.symbols.callBuy           = rollData.buySymbol;
      trade.callSpreadEntryPremium    = rollData.netPremium
                                          ? parseFloat(rollData.netPremium)
                                          : trade.callSpreadEntryPremium;
      // ✅ FIX: was resetting put70Decay for a CE roll — must reset call70Decay
      trade.alertsSent.call70Decay    = false;
    } else {
      trade.symbols.putSell           = rollData.sellSymbol;
      trade.symbols.putBuy            = rollData.buySymbol;
      trade.putSpreadEntryPremium     = rollData.netPremium
                                          ? parseFloat(rollData.netPremium)
                                          : trade.putSpreadEntryPremium;
      trade.alertsSent.put70Decay     = false;
    }

    // Recalculate total entry premium after roll
    trade.totalEntryPremium = trade.callSpreadEntryPremium + trade.putSpreadEntryPremium;
    await trade.save();

    // ✅ FIX: use sendCondorAlert (not sendTelegramAlert)
    sendCondorAlert(
      `✅ <b>Roll Executed: ${trade.index} ${rollData.side}</b>\n` +
      `New: SELL ${rollData.sellSymbol} / BUY ${rollData.buySymbol}\n` +
      `Net Premium: ₹${rollData.netPremium ?? 'N/A'}`
    );

    res.status(200).json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;