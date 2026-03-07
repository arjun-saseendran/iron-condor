/**
 * upstoxLiveData.js
 *
 * Upstox WebSocket live feed — used ONLY for Iron Condor price updates.
 * Traffic Light strategy keeps using fyersLiveData.js (Fyers socket) unchanged.
 *
 * Architecture:
 *   fyersLiveData.js  → NIFTY spot tick → Traffic Light engine (unchanged)
 *   upstoxLiveData.js → NIFTY/SENSEX spot + IC option legs → Iron Condor engine
 *
 * Symbol format used internally for condorPrices cache:
 *   Upstox instrument key format: "NSE_INDEX|Nifty 50", "NSE_FO|NIFTY10MAR202522500CE"
 *   These keys are what Upstox sends back in tick messages and what
 *   monitorCondorLevels looks up via kiteToUpstoxSymbol().
 */

import pkg from 'upstox-js-sdk';
const { ApiClient } = pkg;
import { getIO } from '../config/socket.js';
import {
  updateCondorPrice,
  monitorCondorLevels,
} from '../Engines/ironCondorEngine.js';
// ✅ FIX: use lazy getter — getActiveTradeModel() not called until after DB connects
import getActiveTradeModel from '../models/ironCondorActiveTradeModel.js';
import {
  kiteToUpstoxSymbol,
  getUpstoxIndexSymbol,
} from '../services/upstoxSymbolMapper.js';

// ── Upstox websocket instance (kept for dynamic re-subscription) ────────────
let _upstoxWs       = null;
let _subscribedKeys = new Set();

// ── Feed type: ltpc = LTP + close only (fastest, sufficient for SL monitoring) ──
const FEED_TYPE   = 'ltpc';

// ── Index spot keys ──────────────────────────────────────────────────────────
const NIFTY_SPOT  = 'NSE_INDEX|Nifty 50';
const SENSEX_SPOT = 'BSE_INDEX|SENSEX';

// ── monitorCondorLevels throttle ─────────────────────────────────────────────
// monitorCondorLevels hits MongoDB on every call.
// Upstox fires ticks for every subscribed symbol — without throttling this
// would run a DB query hundreds of times per second.
// ✅ FIX: throttle to once per 500ms regardless of tick volume.
let _lastMonitorTime = 0;
const MONITOR_THROTTLE_MS = 500;

/**
 * Dynamically add a new Upstox symbol to the live subscription.
 * ✅ FIX: export is correct — but must be called from scanAndSyncOrders
 *         after a new ActiveTrade is created so new option legs get subscribed.
 *
 * @param {string} upstoxKey  e.g. "NSE_FO|NIFTY10MAR202522500CE"
 */
export const subscribeCondorSymbol = (upstoxKey) => {
  if (!upstoxKey || _subscribedKeys.has(upstoxKey)) return;
  _subscribedKeys.add(upstoxKey);

  if (!_upstoxWs || _upstoxWs.readyState !== 1 /* OPEN */) {
    console.warn('⚠️ Upstox WS not ready — symbol queued and will be sent on reconnect:', upstoxKey);
    return;
  }
  _sendSubscription([...Array.from(_subscribedKeys)]);
  console.log(`📡 Upstox: dynamically subscribed to ${upstoxKey}`);
};

// ── Internal: send subscription message ─────────────────────────────────────
const _sendSubscription = (keys) => {
  if (!_upstoxWs || !keys.length) return;
  const msg = {
    guid:   'condor-sub',
    method: 'sub',
    data:   { mode: FEED_TYPE, instrumentKeys: keys },
  };
  _upstoxWs.send(JSON.stringify(msg));
};

/**
 * Parse an Upstox WebSocket tick message (binary protobuf).
 * Returns array of { key, price } objects.
 */
let _proto = null;

const parseTick = async (rawMsg) => {
  try {
    if (typeof rawMsg === 'string') return []; // heartbeat / control frame

    if (!_proto) {
      try {
        const protobuf = (await import('protobufjs')).default;
        const { createRequire } = await import('module');
        const req = createRequire(import.meta.url);
        const protoPath = req.resolve('upstox-js-sdk')
          .replace('index.js', '')
          .replace('src/', '') + 'MarketDataFeed.proto';
        _proto = await protobuf.load(protoPath).catch(() => null);
      } catch (_) {
        _proto = null;
      }
    }

    if (_proto) {
      const FeedResponse = _proto.lookupType(
        'com.upstox.marketdatafeeder.rpc.proto.FeedResponse'
      );
      const buf     = rawMsg instanceof ArrayBuffer ? Buffer.from(rawMsg) : rawMsg;
      const decoded = FeedResponse.decode(buf);
      const data    = FeedResponse.toObject(decoded, { longs: Number, defaults: true });

      if (!data?.feeds) return [];
      return Object.entries(data.feeds)
        .map(([key, feed]) => {
          const price = feed?.ltpc?.ltp ?? null;
          return price != null ? { key, price } : null;
        })
        .filter(Boolean);
    }

    // Fallback: JSON text frames (dev/test environments)
    const text = rawMsg.toString('utf8');
    const data = JSON.parse(text);
    if (!data?.feeds) return [];
    return Object.entries(data.feeds)
      .map(([key, feed]) => {
        const price = feed?.ltpc?.ltp ?? feed?.ff?.marketFF?.ltpc?.ltp ?? null;
        return price != null ? { key, price } : null;
      })
      .filter(Boolean);

  } catch {
    return []; // silently ignore decode errors / heartbeat frames
  }
};

/**
 * Init the Upstox live data socket for Iron Condor.
 * Called once from server startup after DB is connected.
 */
export const initUpstoxLiveData = async () => {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) {
    console.error('❌ Upstox Live Data: UPSTOX_ACCESS_TOKEN missing in .env');
    return;
  }

  const io = getIO();

  // ✅ FIX: call getActiveTradeModel() lazily here (after DB is connected)
  //         Previously: const ActiveTrade = getActiveTradeModel() at module level
  //         — this ran before mongoose connected, returning a broken model reference
  const ActiveTrade = getActiveTradeModel();

  console.log('🔌 Connecting to Upstox Live Data Socket (Iron Condor)...');

  // ── Build initial subscription list ────────────────────────────────────────
  let initialKeys = [NIFTY_SPOT, SENSEX_SPOT];

  try {
    const activeTrade = await ActiveTrade.findOne({ status: 'ACTIVE' });
    if (activeTrade) {
      const idx      = activeTrade.index;
      const legSymbols = [
        activeTrade.symbols.callSell,
        activeTrade.symbols.callBuy,
        activeTrade.symbols.putSell,
        activeTrade.symbols.putBuy,
      ]
        .filter(Boolean)
        .map(kite => kiteToUpstoxSymbol(kite, idx))
        .filter(Boolean);

      initialKeys = [
        ...new Set([...initialKeys, getUpstoxIndexSymbol(idx), ...legSymbols])
      ];
    }
  } catch (err) {
    console.error('❌ Upstox: could not load active trade for subscription:', err.message);
  }

  initialKeys.forEach(k => _subscribedKeys.add(k));

  // ── Connect via Upstox v3 authorize endpoint ───────────────────────────────
  try {
    const authRes = await fetch(
      'https://api.upstox.com/v3/feed/market-data-feed/authorize',
      {
        method:  'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json',
          'Api-Version':   '2.0',
        },
      }
    );

    if (!authRes.ok) {
      console.error(`❌ Upstox WS auth failed (${authRes.status}):`, await authRes.text());
      return;
    }

    const authData = await authRes.json();
    const wsUrl    = authData?.data?.authorizedRedirectUri;

    if (!wsUrl) {
      console.error('❌ Upstox WS: no authorizedRedirectUri in auth response', authData);
      return;
    }

    const WS = globalThis.WebSocket || (await import('ws')).default;
    const ws = new WS(wsUrl);
    _upstoxWs = ws;

    ws.onopen = () => {
      console.log(`✅ Upstox Live Data Connected! Subscribing ${initialKeys.length} symbols.`);
      _sendSubscription(Array.from(_subscribedKeys));
    };

    ws.onmessage = async (event) => {
      const ticks = await parseTick(event.data);

      for (const { key, price } of ticks) {
        // Update Iron Condor price cache
        updateCondorPrice(key, price);

        // Emit NIFTY spot to dashboard
        if (key === NIFTY_SPOT && io) {
          io.emit('market_tick', { price, timestamp: Date.now() });
        }
      }

      // ✅ FIX: throttle monitorCondorLevels — was called on EVERY tick batch
      //         (hundreds of MongoDB queries/sec when many symbols are subscribed)
      if (ticks.length > 0) {
        const now = Date.now();
        if (now - _lastMonitorTime >= MONITOR_THROTTLE_MS) {
          _lastMonitorTime = now;
          await monitorCondorLevels();
        }
      }
    };

    ws.onerror = (err) => {
      console.error('❌ Upstox Live Data Error:', err.message || err);
    };

    ws.onclose = () => {
      console.warn('⚠️ Upstox Live Data Closed. Reconnecting in 5s...');
      _upstoxWs = null;
      setTimeout(() => initUpstoxLiveData(), 5000);
    };

  } catch (err) {
    console.error('❌ Upstox WS connection error:', err.message);
    setTimeout(() => initUpstoxLiveData(), 5000);
  }
};