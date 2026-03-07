/**
 * fyersLiveData.js
 *
 * Fyers WebSocket — used ONLY for Traffic Light strategy (NIFTY spot ticks + candle building).
 *
 * ✅ FIX: Iron Condor price feeding REMOVED from this file.
 *    Iron Condor uses upstoxLiveData.js exclusively.
 *    Reason: ironCondorEngine.condorPrices is keyed by Upstox instrument keys
 *    (e.g. "NSE_FO|NIFTY10MAR202522500CE"). Fyers uses a different key format
 *    ("NSE:NIFTY25310CE"). Feeding Fyers keys into condorPrices caused all
 *    condorPrices lookups in monitorCondorLevels to return 0 — SL never fired.
 *
 * Architecture:
 *   fyersLiveData.js  → NIFTY spot tick → Traffic Light engine only
 *   upstoxLiveData.js → NIFTY/SENSEX spot + IC option legs → Iron Condor engine
 */

import { fyersDataSocket } from "fyers-api-v3";
import { getIO } from "../config/socket.js";
import { CandleBuilder } from "../services/candleBuilderTraficLight.js";
import { handleNewCandle, handleTick } from "../Engines/traficLightEngine.js";

// Iron Condor imports REMOVED — Upstox handles those now

const NIFTY_SPOT        = "NSE:NIFTY50-INDEX";
const niftyCandleBuilder = new CandleBuilder(3);

export const initFyersLiveData = async () => {
  const io          = getIO();
  const accessToken = process.env.FYERS_ACCESS_TOKEN;
  const appId       = process.env.FYERS_APP_ID;

  if (!accessToken || !appId) {
    console.error("❌ Fyers Live Data: Missing FYERS_ACCESS_TOKEN or FYERS_APP_ID in .env");
    return;
  }

  const wsAppId = appId.includes("-") ? appId : `${appId}-100`;
  const wsToken = accessToken.includes(":")
    ? accessToken
    : `${wsAppId}:${accessToken}`;

  console.log("🔌 Connecting to Fyers Live Data Socket (Traffic Light only)...");
  const fyersData = fyersDataSocket.getInstance(wsToken, "./logs");
  fyersData.autoreconnect();

  fyersData.on("connect", () => {
    console.log("✅ Fyers Live Data Connected! Subscribing NIFTY spot for Traffic Light.");
    // Only subscribe NIFTY spot — Traffic Light only needs this
    fyersData.subscribe([NIFTY_SPOT], false);
  });

  fyersData.on("message", async (msg) => {
    const symbol = msg.symbol || msg.n;
    const price  = msg.ltp    || msg.v?.lp;

    if (!symbol || !price) return;

    // 🚦 Traffic Light — NIFTY spot only
    if (symbol === NIFTY_SPOT) {
      await handleTick(price);

      if (io) io.emit("market_tick", { price, timestamp: Date.now() });

      const finishedCandle = niftyCandleBuilder.build(price, Date.now());
      if (finishedCandle) {
        console.log(
          `\n📦 New 3-Min Candle: ${finishedCandle.color.toUpperCase()} | Range: ${finishedCandle.range.toFixed(2)}`
        );
        handleNewCandle(finishedCandle);
      }
    }
    // All other symbols ignored — Iron Condor handled by upstoxLiveData.js
  });

  fyersData.on("error", (err) =>
    console.error("❌ Fyers Live Data Error:", err)
  );
  fyersData.on("close", () =>
    console.log("⚠️ Fyers Live Data Closed. Auto-reconnecting...")
  );

  fyersData.connect();
};