/**
 * autoCondorRoutes.js
 * Routes for full-auto Iron Condor mode.
 *
 * POST /api/auto-condor/activate
 * POST /api/auto-condor/deactivate
 * POST /api/auto-condor/toggle       — switch a specific trade between semi/auto
 * GET  /api/auto-condor/status
 */
import express from 'express';
import {
  activateAutoMode,
  deactivateAutoMode,
  getAutoModeStatus,
  toggleTradeAutoMode,   // ✅ FIX: was exported from engine but had no route
} from '../Engines/autoCondorEngine.js';

const router = express.Router();

// ✅ FIX: activateAutoMode is async — must await, otherwise res.json gets a Promise
router.post('/activate', async (req, res) => {
  try {
    const result = await activateAutoMode();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ✅ FIX: deactivateAutoMode is async — must await
router.post('/deactivate', async (req, res) => {
  try {
    const result = await deactivateAutoMode();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ✅ NEW: toggle a specific trade between semi-auto and auto mode
// Body: { tradeId: "mongodb_object_id" }
router.post('/toggle', async (req, res) => {
  try {
    const { tradeId } = req.body;
    if (!tradeId) return res.status(400).json({ ok: false, msg: 'tradeId is required' });
    const result = await toggleTradeAutoMode(tradeId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// getAutoModeStatus is synchronous — no await needed
router.get('/status', (req, res) => {
  res.json(getAutoModeStatus());
});

export default router;