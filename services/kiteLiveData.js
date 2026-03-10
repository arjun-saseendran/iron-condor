// ─── Kite Live Data (WebSocket Ticker) ───────────────────────────────────────
// Connects to Kite WebSocket (KiteTicker) for real-time LTP.
// Prices are stored in condorPrices{} (owned by ironCondorEngine) via callback.
// This service is DATA ONLY — no orders are placed here.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { KiteTicker } from "kiteconnect";

let ticker          = null;
let reconnectTimer  = null;
const subscribedTokens = new Set();  // instrument_token (number) set

// ─── Staleness tracking ───────────────────────────────────────────────────────
let _lastTickTime  = null;
let _feedConnected = false;

const STALE_THRESHOLD_MS = 30_000;

export const isFeedStale = () => {
  if (!_feedConnected) return true;
  if (!_lastTickTime)  return true;
  return (Date.now() - _lastTickTime) > STALE_THRESHOLD_MS;
};

export const getLastTickAge = () =>
  _lastTickTime ? Math.floor((Date.now() - _lastTickTime) / 1000) : null;

// Callback registered by ironCondorEngine to receive price updates
// Called as: _priceCallback(instrumentToken, ltp)
let _priceCallback = null;
export const onPriceUpdate = (fn) => { _priceCallback = fn; };

// ─── Connect ──────────────────────────────────────────────────────────────────
export const initKiteLiveData = () => {
  const apiKey     = process.env.KITE_API_KEY;
  const token      = process.env.KITE_ACCESS_TOKEN;

  if (!apiKey || !token) {
    console.warn("⚠️ KITE_API_KEY or KITE_ACCESS_TOKEN missing — live ticker disabled");
    return;
  }

  _connect(apiKey, token);
};

const _connect = (apiKey, accessToken) => {
  if (ticker) {
    try { ticker.disconnect(); } catch (_) {}
    ticker = null;
  }

  ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

  ticker.connect();

  ticker.on("connect", () => {
    console.log("✅ Kite WebSocket connected");
    _feedConnected = true;
    if (subscribedTokens.size > 0) {
      _sendSubscribe([...subscribedTokens]);
    }
  });

  ticker.on("ticks", (ticks) => {
    for (const tick of ticks) {
      const ltp = tick.last_price;
      // ✅ FIX: update _lastTickTime on ANY tick, even ltp=0 — feed is alive
      //         Previously ltp=0 ticks were ignored, causing false stale detection
      _lastTickTime = Date.now();
      if (ltp != null && _priceCallback) {
        _priceCallback(tick.instrument_token, ltp);
      }
    }
  });

  ticker.on("disconnect", (error) => {
    _feedConnected = false;
    console.warn("⚠️ Kite WebSocket disconnected:", error?.message || "");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => _connect(apiKey, accessToken), 5000);
  });

  ticker.on("error", (error) => {
    _feedConnected = false;
    console.error("❌ Kite WebSocket error:", error?.message || error);
    // ✅ FIX: error event does NOT automatically trigger disconnect event in all cases.
    //         Without this, ticker stays dead silently after a network error.
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => _connect(apiKey, accessToken), 5000);
  });

  ticker.on("noreconnect", () => {
    console.error("❌ Kite WebSocket: max reconnect attempts reached");
  });
};

// ─── Subscribe ────────────────────────────────────────────────────────────────
const _sendSubscribe = (tokens) => {
  if (!ticker || !ticker.connected()) return;
  ticker.subscribe(tokens);
  ticker.setMode(ticker.modeLTP, tokens);
};

// Subscribe a single instrument_token (number)
export const subscribeCondorToken = (instrumentToken) => {
  if (!instrumentToken) return;
  const tok = Number(instrumentToken);
  if (!subscribedTokens.has(tok)) {
    subscribedTokens.add(tok);
    _sendSubscribe([tok]);
  }
};

export const subscribeManyTokens = (instrumentTokens) => {
  const newToks = instrumentTokens
    .map(Number)
    .filter(t => t && !subscribedTokens.has(t));
  if (newToks.length === 0) return;
  newToks.forEach(t => subscribedTokens.add(t));
  _sendSubscribe(newToks);
};