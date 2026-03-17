// ─── Kite Live Data (WebSocket Ticker) ───────────────────────────────────────
// Connects to Kite WebSocket (KiteTicker) for:
//   1. Real-time LTP (binary ticks) → condorPrices via _priceCallback
//   2. Order update push (text/JSON) → resolves waitForOrderConfirmation()
//
// KiteTicker delivers BOTH on a single WebSocket connection:
//   - Market data = binary messages  → ticker.on("ticks", ...)
//   - Order updates = text/JSON      → ticker.on("order_update", ...)
// No separate socket needed for Kite.
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

// ─── Order confirmation ───────────────────────────────────────────────────────
// TWO sources can resolve a pending order — whichever arrives first wins:
//   1. Kite Postback (HTTP POST to /api/orders/postback) — most reliable
//   2. Kite WebSocket order_update — backup, arrives on same connection as ticks
//
// Both call _resolveOrder() internally.
// waitForOrderConfirmation() registers the listener BEFORE placeOrder() is called
// so neither postback nor WebSocket push can be missed.
// Hard timeout of 60s → falls back to REST poll in ironCondorEngine.
// ─────────────────────────────────────────────────────────────────────────────

// Pending order confirmations: Map of orderId → { resolve, reject, timer }
const _pendingOrders = new Map();

// ─── Internal: resolve or reject a pending order ─────────────────────────────
function _resolveOrder(order, source) {
  const id     = String(order?.order_id ?? order?.orderId ?? "");
  const status = String(order?.status ?? "");

  if (!id || !_pendingOrders.has(id)) return;

  if (status === "COMPLETE") {
    const { resolve, timer } = _pendingOrders.get(id);
    clearTimeout(timer);
    _pendingOrders.delete(id);
    const avgPrice = order?.average_price ?? order?.avgPrice ?? 0;
    console.log(`✅ [${source}] Order ${id} COMPLETE | avgPrice=${avgPrice}`);
    resolve({ orderId: id, avgPrice });

  } else if (status === "REJECTED" || status === "CANCELLED") {
    const { reject, timer } = _pendingOrders.get(id);
    clearTimeout(timer);
    _pendingOrders.delete(id);
    const reason = order?.status_message || status;
    console.error(`❌ [${source}] Order ${id} ${status}: ${reason}`);
    reject(new Error(`REJECTED: ${order?.tradingsymbol ?? id} — ${reason}`));
  }
  // All other statuses (OPEN, UPDATE, TRIGGER PENDING) → wait for final push
}

// ─── PUBLIC: called by server.js postback route ───────────────────────────────
// Kite POSTs order updates to /api/orders/postback when orders fill/reject.
// This is the PRIMARY confirmation method — more reliable than WebSocket push.
export const resolveOrderFromPostback = (order) => {
  const id     = String(order?.order_id ?? "");
  const status = String(order?.status ?? "");
  console.log(`📬 [Postback] order_id=${id} status=${status} avgPrice=${order?.average_price ?? 0}`);
  _resolveOrder(order, "Postback");
};

// ─── PUBLIC: called by ironCondorEngine's placeAndConfirm() ──────────────────
// Register BEFORE placing the order so neither postback nor WebSocket is missed.
// Hard timeout 60s → falls back to REST poll in ironCondorEngine.
export const waitForOrderConfirmation = (orderId, timeoutMs = 60000) => {
  return new Promise((resolve, reject) => {
    const id = String(orderId);

    const timer = setTimeout(() => {
      _pendingOrders.delete(id);
      reject(new Error(`Order ${id}: No confirmation from Kite in ${timeoutMs / 1000}s (postback + socket both silent)`));
    }, timeoutMs);

    _pendingOrders.set(id, { resolve, reject, timer });
  });
};

// ─── Internal: handle incoming order_update from Kite WebSocket ───────────────
// BACKUP — fires if postback didn't arrive first.
// Both can fire safely — _resolveOrder() ignores already-resolved orders.
function _handleOrderUpdate(order) {
  _resolveOrder(order, "WebSocket");
}

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

  // ── Order update push — resolves waitForOrderConfirmation() instantly ──────
  // Kite streams order updates as text/JSON on the same WebSocket connection.
  // Terminal statuses: COMPLETE → resolve, REJECTED/CANCELLED → reject.
  // Non-terminal (OPEN, UPDATE) → ignored, Kite will push again when final.
  ticker.on("order_update", (order) => {
    console.log(`📬 [KiteTicker] order_update: ${order?.order_id} status=${order?.status}`);
    _handleOrderUpdate(order);
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