import express from 'express';
import { fetchAndCategorizePositions } from '../services/positionService.js';

const router = express.Router();

// GET /api/positions - Fetch and analyze live positions from Kite
router.get('/', async (req, res) => {
  try {
    const positionData = await fetchAndCategorizePositions();
    
    res.status(200).json({
      status: 'success',
      message: 'Positions fetched and categorized successfully',
      data: positionData
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to fetch positions', 
      error: error.message 
    });
  }
});

export default router;