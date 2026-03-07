import { defaultClient, setUpstoxAccessToken } from "../config/upstoxConfig.js";
import pkg from "upstox-js-sdk";
const { UserApi, MarketQuoteApi } = pkg;
import axios from "axios";

// ==========================================
// LOGIN — redirects to Upstox OAuth page
// ==========================================
export const loginUpstox = (req, res) => {
  try {
    const loginUrl =
      `https://api.upstox.com/v2/login/authorization/dialog` +
      `?client_id=${process.env.UPSTOX_API_KEY}` +
      `&redirect_uri=${encodeURIComponent(process.env.UPSTOX_REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=orders`;

    console.log("🔗 Redirecting to Upstox login...");
    res.redirect(loginUrl);
  } catch (error) {
    console.error("❌ Upstox Login URL error:", error.message);
    res.status(500).json({ error: "Could not generate Upstox login URL" });
  }
};

// ==========================================
// CALLBACK — receives auth code,
// exchanges for access token, saves to disk
// ==========================================
export const upstoxCallback = async (req, res) => {
  const authCode = req.query.code;

  if (!authCode) {
    return res.status(400).json({ error: "No auth code received from Upstox" });
  }

  try {
    const tokenRes = await axios.post(
      "https://api.upstox.com/v2/login/authorization/token",
      new URLSearchParams({
        code:          authCode,
        client_id:     process.env.UPSTOX_API_KEY,
        client_secret: process.env.UPSTOX_API_SECRET,
        redirect_uri:  process.env.UPSTOX_REDIRECT_URI,
        grant_type:    "authorization_code",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (!tokenRes.data?.access_token) {
      console.error("❌ Upstox token exchange failed:", tokenRes.data);
      return res.status(400).send("Upstox token generation failed");
    }

    const accessToken = tokenRes.data.access_token;

    // Set token in SDK + env + persist to .env
    setUpstoxAccessToken(accessToken);

    console.log("✅ Upstox session created.");
    res.status(200).send(
      "<h1>✅ Upstox Connected!</h1><p>Access token saved. You can close this tab.</p>"
    );
  } catch (error) {
    console.error("❌ Upstox Auth Error:", error.message);
    res.status(500).json({ error: "Upstox authentication failed", details: error.message });
  }
};

// ==========================================
// PROFILE
// ==========================================
export const getUpstoxProfile = async (req, res) => {
  try {
    const api = new UserApi();
    const response = await api.getProfile(process.env.UPSTOX_API_VERSION || "2.0");
    res.json(response.data);
  } catch (error) {
    console.error("❌ Upstox Profile Error:", error.message);
    res.status(500).json({ error: "Failed to fetch Upstox profile" });
  }
};

// ==========================================
// QUOTES
// ==========================================
export const getUpstoxQuotes = async (req, res) => {
  try {
    const symbols = req.query.symbols || "NSE_EQ|INE002A01018";
    const api = new MarketQuoteApi();
    const keysArray = symbols.split(",").map(s => s.trim());
    const response = await api.getFullMarketQuote(keysArray, process.env.UPSTOX_API_VERSION || "2.0");
    res.json(response.data);
  } catch (error) {
    console.error("❌ Upstox Quotes Error:", error.message);
    res.status(500).json({ error: "Failed to fetch Upstox quotes" });
  }
};