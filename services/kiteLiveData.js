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
// RACE CONDITION FIX:
// Kite postback or WebSocket order_update can arrive BEFORE placeOrder() returns
// the order_id. This is a known Kite API behaviour.
//
// Solution: buffer ALL incoming order updates immediately.
// When waitForOrderConfirmation(orderId) is called after placeOrder():
//   - Check buffer first — if update already arrived, resolve immediately
//   - If not in buffer yet — register listener and wait for it
//
// TWO sources feed into the buffer — whichever arrives first wins:
//   1. Kite Postback (HTTP POST to /api/orders/postback) — primary
//   2. Kite WebSocket order_update — backup
//
// Hard timeout 60s → falls back to REST poll in ironCondorEngine.
// ─────────────────────────────────────────────────────────────────────────────

// Early arrival buffer: orderId → { status, avgPrice, reason, timestamp }
// Holds updates that arrived before waitForOrderConfirmation() was called
const _earlyBuffer = new Map();
const BUFFER_TTL_MS = 120_000; // 2 minutes — clear stale buffer entries

// Pending listeners: orderId → { resolve, reject, timer }
const _pendingOrders = new Map();

// ─── Internal: process any incoming order update ──────────────────────────────
function _resolveOrder(order, source) {
  const id     = String(order?.order_id ?? order?.orderId ?? "");
  const status = String(order?.status ?? "");
  if (!id) return;

  const avgPrice = order?.average_price ?? order?.avgPrice ?? 0;
  const reason   = order?.status_message || status;

  console.log(`📬 [${source}] order_id=${id} status=${status} avgPrice=${avgPrice}`);

  // ── If listener already waiting — resolve immediately ─────────────────────
  if (_pendingOrders.has(id)) {
    const { resolve, reject, timer } = _pendingOrders.get(id);
    clearTimeout(timer);
    _pendingOrders.delete(id);

    if (status === "COMPLETE") {
      console.log(`✅ [${source}] Order ${id} COMPLETE | avgPrice=${avgPrice}`);
      resolve({ orderId: id, avgPrice });
    } else if (status === "REJECTED" || status === "CANCELLED") {
      console.error(`❌ [${source}] Order ${id} ${status}: ${reason}`);
      reject(new Error(`REJECTED: ${order?.tradingsymbol ?? id} — ${reason}`));
    }
    // Non-terminal status — Kite will push again, keep listener alive
    return;
  }

  // ── Listener not registered yet — buffer the update ───────────────────────
  // Only buffer terminal statuses — non-terminal will push again anyway
  if (status === "COMPLETE" || status === "REJECTED" || status === "CANCELLED") {
    _earlyBuffer.set(id, { status, avgPrice, reason, tradingsymbol: order?.tradingsymbol, timestamp: Date.now() });
    // Auto-clean buffer after TTL to prevent memory leak
    setTimeout(() => _earlyBuffer.delete(id), BUFFER_TTL_MS);
  }
}

// ─── PUBLIC: called by server.js postback route ───────────────────────────────
export const resolveOrderFromPostback = (order) => {
  _resolveOrder(order, "Postback");
};

// ─── PUBLIC: called by ironCondorEngine's placeAndConfirm() ──────────────────
// Call AFTER placeOrder() returns the orderId.
// Checks buffer first — if update already arrived during placeOrder() gap,
// resolves immediately without waiting.
// Hard timeout 60s → falls back to REST poll in ironCondorEngine.
export const waitForOrderConfirmation = (orderId, timeoutMs = 60000) => {
  return new Promise((resolve, reject) => {
    const id = String(orderId);

    // ── Check early arrival buffer first ─────────────────────────────────────
    if (_earlyBuffer.has(id)) {
      const buffered = _earlyBuffer.get(id);
      _earlyBuffer.delete(id);

      if (buffered.status === "COMPLETE") {
        console.log(`✅ [Buffer] Order ${id} already COMPLETE | avgPrice=${buffered.avgPrice}`);
        resolve({ orderId: id, avgPrice: buffered.avgPrice });
      } else {
        console.error(`❌ [Buffer] Order ${id} already ${buffered.status}: ${buffered.reason}`);
        reject(new Error(`REJECTED: ${buffered.tradingsymbol ?? id} — ${buffered.reason}`));
      }
      return; // resolved from buffer — no need to register listener
    }

    // ── Not in buffer — register listener for future push ────────────────────
    const timer = setTimeout(() => {
      _pendingOrders.delete(id);
      reject(new Error(`Order ${id}: No confirmation from Kite in ${timeoutMs / 1000}s (postback + socket both silent)`));
    }, timeoutMs);

    _pendingOrders.set(id, { resolve, reject, timer });
  });
};

// ─── Internal: handle incoming order_update from Kite WebSocket ───────────────
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