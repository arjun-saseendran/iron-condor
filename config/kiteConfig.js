import { KiteConnect } from 'kiteconnect';
import dotenv from 'dotenv';
import { Token } from '../models/tokenModel.js';

dotenv.config();

const kc = new KiteConnect({
  api_key:      process.env.KITE_API_KEY,
  redirect_uri: process.env.KITE_REDIRECT_URL,
});

let dailyAccessToken = null;

// ─── Load token from DB on startup ───────────────────────────────────────────
export const loadTokenFromDB = async () => {
  const saved = await Token.findOne({});
  if (saved?.accessToken) {
    dailyAccessToken = saved.accessToken;
    kc.setAccessToken(saved.accessToken);
    console.log("✅ Kite access token loaded from DB");
    return saved.accessToken;
  }
  console.warn("⚠️ No Kite token in DB — visit /api/auth/zerodha/login to authenticate");
  return null;
};

// ─── Set token in memory only (DB save handled in authControllers) ────────────
export const setAccessToken = (token) => {
  dailyAccessToken = token;
  kc.setAccessToken(token);
  console.log("✅ Kite access token set in memory");
};

// ─── Get Kite instance ────────────────────────────────────────────────────────
export const getKiteInstance = () => kc;