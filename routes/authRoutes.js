import express from "express";
import { loginFyers, fyersCallback, getProfile, getQuotes } from "../controllers/fyersControllers.js";
import { loginKite, kiteCallback } from "../controllers/kiteControllers.js";
import { loginUpstox, upstoxCallback, getUpstoxProfile, getUpstoxQuotes } from "../controllers/upstoxControllers.js";

const router = express.Router();

// ─── Fyers Routes ─────────────────────────────────────────────────────────────
router.get("/fyers/login",    loginFyers);
router.get("/fyers/callback", fyersCallback);
router.get("/fyers/profile",  getProfile);
router.get("/fyers/quotes",   getQuotes);

// ─── Zerodha/Kite Routes (Iron Condor order execution) ────────────────────────
router.get("/zerodha/login",    loginKite);
router.get("/zerodha/callback", kiteCallback);

// ─── Upstox Routes ────────────────────────────────────────────────────────────
router.get("/upstox/login",    loginUpstox);
router.get("/upstox/callback", upstoxCallback);
router.get("/upstox/profile",  getUpstoxProfile);
router.get("/upstox/quotes",   getUpstoxQuotes);

export default router;
