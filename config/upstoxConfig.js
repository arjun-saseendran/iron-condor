import pkg from 'upstox-js-sdk';
// ✅ FIX: PlaceOrderRequest must be destructured from pkg here.
// placeOrder() was calling `new UpstoxClient.PlaceOrderRequest(...)` but
// UpstoxClient was NEVER imported anywhere in this file — ReferenceError at
// runtime on every live order placement, silently killing the order flow.
const {
  ApiClient,
  MarketQuoteApi,
  OrderApi,
  PortfolioApi,
  OptionsApi,
  PlaceOrderRequest,   // ✅ FIX: destructured directly from pkg
} = pkg;

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// =============================
// 🔐 INIT UPSTOX
// =============================
const defaultClient = ApiClient.instance;
const oauth2        = defaultClient.authentications['OAUTH2'];

let _accessToken = null;

const token = process.env.UPSTOX_ACCESS_TOKEN;
if (token) {
  oauth2.accessToken = token;
  _accessToken       = token;
  console.log("✅ Upstox Access Token Loaded");
} else {
  console.warn("⚠️ UPSTOX_ACCESS_TOKEN missing in .env. Waiting for auto login.");
}

// =============================
// 🔑 DYNAMIC TOKEN SETTER
// =============================
export const setUpstoxAccessToken = (newToken) => {
  _accessToken          = newToken;
  oauth2.accessToken    = newToken;
  process.env.UPSTOX_ACCESS_TOKEN = newToken;

  const envPath = path.resolve(process.cwd(), ".env");
  let envData   = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

  const key     = "UPSTOX_ACCESS_TOKEN";
  const regex   = new RegExp(`^${key}=.*`, "m");
  const newLine = `${key}="${newToken}"`;

  envData = regex.test(envData)
    ? envData.replace(regex, newLine)
    : envData + (envData.endsWith("\n") ? "" : "\n") + newLine + "\n";

  fs.writeFileSync(envPath, envData, "utf8");
  console.log("✅ Upstox Access Token dynamically updated.");
};

// =============================
// 🏭 GET API INSTANCES
// =============================
export const getUpstoxMarketApi    = () => new MarketQuoteApi();
export const getUpstoxOrderApi     = () => new OrderApi();
export const getUpstoxPortfolioApi = () => new PortfolioApi();

// =============================
// 💹 GET LTP
// =============================
export const getLTP = async (instrumentKeys) => {
  try {
    const tok = process.env.UPSTOX_ACCESS_TOKEN;
    if (!tok) throw new Error('UPSTOX_ACCESS_TOKEN not set');

    const keysArray = Array.isArray(instrumentKeys)
      ? instrumentKeys
      : instrumentKeys.split(',');

    const params = new URLSearchParams({ instrument_key: keysArray.join(',') });
    const res = await fetch(
      `https://api.upstox.com/v2/market-quote/ltp?${params}`,
      {
        method:  'GET',
        headers: {
          'Authorization': `Bearer ${tok}`,
          'Accept':        'application/json',
          'Api-Version':   '2.0',
        },
      }
    );

    if (!res.ok) throw new Error(`Upstox LTP HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json?.status === 'success' ? json.data : null;
  } catch (error) {
    console.error("❌ Upstox LTP Error:", error.message);
    return null;
  }
};

// =============================
// 📈 GET FULL QUOTES
// =============================
export const getQuotes = async (instrumentKeys) => {
  try {
    const api       = getUpstoxMarketApi();
    const keysArray = Array.isArray(instrumentKeys)
      ? instrumentKeys
      : instrumentKeys.split(',');
    const response  = await api.getFullMarketQuote(keysArray, process.env.UPSTOX_API_VERSION || "2.0");
    return response?.status === "success" ? response.data : null;
  } catch (error) {
    console.error("❌ Upstox Quotes Error:", error.message);
    return null;
  }
};

// =============================
// 📅 GET LAST CLOSE PRICE
// =============================
export const getLastClose = async (instrumentKey) => {
  try {
    const tok = process.env.UPSTOX_ACCESS_TOKEN;
    if (!tok) throw new Error('UPSTOX_ACCESS_TOKEN not set');

    const to   = new Date(); to.setDate(to.getDate() + 1);
    const from = new Date(); from.setDate(from.getDate() - 5);
    const fmt  = d => d.toISOString().split('T')[0];

    const encodedKey = instrumentKey.replace('|', '%7C');
    const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/day/${fmt(to)}/${fmt(from)}`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Accept':        'application/json',
        'Api-Version':   '2.0',
      },
    });

    if (!res.ok) throw new Error(`Upstox Historical HTTP ${res.status}: ${await res.text()}`);
    const json    = await res.json();
    const candles = json?.data?.candles;
    return (candles && candles.length > 0) ? candles[0][4] : null;
  } catch (error) {
    console.error('❌ Upstox Last Close Error:', error.message);
    return null;
  }
};

// =============================
// 📊 GET PUT/CALL OPTION CHAIN
// =============================
export const getPCOptionChain = async (instrumentKey, expiryDate) => {
  try {
    const tok = process.env.UPSTOX_ACCESS_TOKEN;
    if (!tok) throw new Error('UPSTOX_ACCESS_TOKEN not set');

    const params = new URLSearchParams({ instrument_key: instrumentKey, expiry_date: expiryDate });
    const res = await fetch(
      `https://api.upstox.com/v2/option/chain?${params}`,
      {
        headers: {
          'Authorization': `Bearer ${tok}`,
          'Accept':        'application/json',
          'Api-Version':   '2.0',
        },
      }
    );

    if (!res.ok) throw new Error(`Upstox PC Option Chain HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json?.status === 'success' ? json.data : null;
  } catch (error) {
    console.error('❌ Upstox PC Option Chain Error:', error.message);
    return null;
  }
};

// =============================
// 📊 GET OPTION GREEKS (v3)
// =============================
export const getOptionGreeks = async (instrumentKeys) => {
  try {
    const tok = process.env.UPSTOX_ACCESS_TOKEN;
    if (!tok) throw new Error('UPSTOX_ACCESS_TOKEN not set');

    const keysArray = Array.isArray(instrumentKeys) ? instrumentKeys : instrumentKeys.split(',');
    const results   = {};

    for (let i = 0; i < keysArray.length; i += 50) {
      const batch  = keysArray.slice(i, i + 50);
      const params = new URLSearchParams({ instrument_key: batch.join(',') });

      const res = await fetch(
        `https://api.upstox.com/v3/market-quote/option-greek?${params}`,
        {
          headers: {
            'Authorization': `Bearer ${tok}`,
            'Accept':        'application/json',
            'Api-Version':   '2.0',
          },
        }
      );

      if (!res.ok) continue;
      const json = await res.json();
      if (json?.status === 'success' && json.data) {
        for (const [k, v] of Object.entries(json.data)) {
          results[k.replace(':', '|')] = v;
        }
      }
    }

    return Object.keys(results).length > 0 ? results : null;
  } catch (error) {
    console.error('❌ Upstox Option Greeks Error:', error.message);
    return null;
  }
};

// =============================
// 📊 GET OPTION CHAIN (SDK legacy)
// =============================
export const getOptionChain = async (instrumentKey, expiryDate) => {
  try {
    const api      = new OptionsApi();
    const response = await api.getOptionContracts(instrumentKey, expiryDate);
    return response?.status === 'success' ? response.data : null;
  } catch (error) {
    console.error('❌ Upstox Option Chain Error:', error.message);
    return null;
  }
};

// =============================
// 🛒 PLACE ORDER
// ✅ FIX: was `new UpstoxClient.PlaceOrderRequest(...)` — UpstoxClient was never
// imported, throwing ReferenceError on every live order. Now uses PlaceOrderRequest
// destructured directly from pkg at the top of this file.
// =============================
export const placeOrder = async (orderData) => {
  try {
    const api  = getUpstoxOrderApi();
    const body = new PlaceOrderRequest(
      orderData.qty,
      orderData.product      || "I",
      orderData.validity     || "DAY",
      orderData.price        || 0,
      orderData.tag          || "mariaalgo",
      orderData.instrumentToken,
      orderData.orderType    || "MARKET",
      orderData.side,
      orderData.disclosedQty || 0,
      orderData.triggerPrice || 0,
      orderData.isAmo        || false,
    );

    const response = await api.placeOrder(body, process.env.UPSTOX_API_VERSION || "2.0");

    if (response?.status === "success") {
      console.log(`✅ Upstox Order Placed: ${response.data.order_id}`);
    } else {
      console.error(`❌ Upstox Order Rejected:`, response);
    }

    return response;
  } catch (error) {
    console.error("❌ Upstox Order Error:", error.message);
    throw error;
  }
};

// =============================
// ❌ CANCEL ORDER
// =============================
export const cancelOrder = async (orderId) => {
  try {
    const api = getUpstoxOrderApi();
    return await api.cancelOrder(orderId, process.env.UPSTOX_API_VERSION || "2.0");
  } catch (error) {
    console.error("❌ Upstox Cancel Order Error:", error.message);
    throw error;
  }
};

// =============================
// 📋 GET POSITIONS
// =============================
export const getPositions = async () => {
  try {
    const api      = getUpstoxPortfolioApi();
    const response = await api.getPositions(process.env.UPSTOX_API_VERSION || "2.0");
    return response?.status === "success" ? response.data : [];
  } catch (error) {
    console.error("❌ Upstox Positions Error:", error.message);
    return [];
  }
};

// =============================
// 📦 GET HOLDINGS
// =============================
export const getHoldings = async () => {
  try {
    const api      = getUpstoxPortfolioApi();
    const response = await api.getHoldings(process.env.UPSTOX_API_VERSION || "2.0");
    return response?.status === "success" ? response.data : [];
  } catch (error) {
    console.error("❌ Upstox Holdings Error:", error.message);
    return [];
  }
};

export { defaultClient };