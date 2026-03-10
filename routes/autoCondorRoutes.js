import express from "express";
import {
  autoEnterIfNeeded,
  autoMonitorTick,
  resetAutoCondorDay,
  getAutoCondorState,
  armAutoCondor,
} from "../Engines/autoCondorEngine.js";

const router = express.Router();

// POST /api/auto-condor/trigger — arms the engine and fires an immediate entry check
router.post("/trigger", async (req, res) => {
  try {
    armAutoCondor();           // ✅ arm first so autoEnterIfNeeded doesn't gate-out
    await autoEnterIfNeeded();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auto-condor/monitor — manual monitor tick trigger
router.post("/monitor", async (req, res) => {
  try {
    await autoMonitorTick();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auto-condor/status
router.get("/status", (req, res) => {
  res.json(getAutoCondorState());
});

// POST /api/auto-condor/reset
router.post("/reset", (req, res) => {
  resetAutoCondorDay();
  res.json({ success: true });
});

export default router;