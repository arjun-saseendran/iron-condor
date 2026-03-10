import express from 'express';
import { fetchAndCategorizePositions } from '../services/ironCondorPositionService.js';

const router = express.Router();

// GET /api/positions - Fetch live status from Zerodha
router.get('/', async (req, res) => {
  try {
    const positionData = await fetchAndCategorizePositions();
    res.status(200).json({
      status: 'success',
      data: positionData
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

export default router;