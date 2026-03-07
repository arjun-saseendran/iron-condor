import { fyersModel } from "fyers-api-v3";
import "dotenv/config";

// =============================
// 🔐 INIT FYERS
// =============================
const fyers = new fyersModel();

fyers.setAppId(process.env.FYERS_APP_ID);
fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI || process.env.FYERS_REDIRECT_URL);

if (process.env.FYERS_ACCESS_TOKEN) {
  fyers.setAccessToken(process.env.FYERS_ACCESS_TOKEN);
  console.log("✅ Fyers Access Token Loaded");
} else {
  console.warn("⚠️ FYERS_ACCESS_TOKEN missing in .env. Waiting for manual/auto login.");
}

// =============================
// 🔑 DYNAMIC TOKEN SETTER
// =============================
export const setFyersAccessToken = (token) => {
  fyers.setAccessToken(token);
  process.env.FYERS_ACCESS_TOKEN = token;
  console.log("✅ Fyers Access Token dynamically updated.");
};

// =============================
// 📈 GET QUOTES
// =============================
export const getQuotes = async (symbols) => {
  try {
    const symbolsArray = Array.isArray(symbols) ? symbols : symbols.split(',');
    const response = await fyers.getQuotes(symbolsArray);
    return (response && response.s === "ok") ? response.d : null;
  } catch (error) {
    console.error("❌ Fyers Quotes Error:", error.message);
    return null;
  }
};

// =============================
// 📊 GET OPTION CHAIN
// =============================
export const getOptionChain = async (symbol) => {
  try {
    const response = await fyers.optionchain({
      symbol: symbol,
      strikecount: 10
    });
    return response;
  } catch (error) {
    console.error("❌ Fyers Option Chain Error:", error.message);
    return null;
  }
};

// =============================
// 🛒 PLACE ORDER
// =============================
export const placeOrder = async (orderData) => {
  try {
    const response = await fyers.place_order(orderData);
    return response;
  } catch (error) {
    console.error("❌ Fyers Order Error:", error.message);
    throw error;
  }
};

// =============================
// ❌ EXIT POSITION
// =============================
export const exitPosition = async (exitData) => {
  try {
    const response = await fyers.exit_positions(exitData);
    return response;
  } catch (error) {
    console.error("❌ Fyers Exit Error:", error.message);
    throw error;
  }
};

export { fyers };
