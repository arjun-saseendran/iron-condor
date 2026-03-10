import { KiteConnect } from 'kiteconnect';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const kc = new KiteConnect({
  api_key:      process.env.KITE_API_KEY,
  redirect_uri: process.env.KITE_REDIRECT_URL,
});

let dailyAccessToken = null;

// ✅ FIX: made async to match server.js which does `await loadTokenFromDisk()`.
// A sync function wrapped in await is harmless but silently drops any future
// async logic (e.g. fetching token from a secrets manager). Async is correct here.
export const loadTokenFromDisk = async () => {
  const token = process.env.KITE_ACCESS_TOKEN;
  if (token) {
    dailyAccessToken = token;
    kc.setAccessToken(token);
    console.log("✅ Kite access token loaded from .env");
    return token;
  }
  console.warn("⚠️ KITE_ACCESS_TOKEN not found in .env");
  return null;
};

export const setAccessToken = (token) => {
  dailyAccessToken = token;
  kc.setAccessToken(token);

  const envPath = path.resolve(process.cwd(), ".env");
  let envData   = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

  const key     = "KITE_ACCESS_TOKEN";
  const regex   = new RegExp(`^${key}=.*`, "m");
  const newLine = `${key}="${token}"`;

  envData = regex.test(envData)
    ? envData.replace(regex, newLine)
    : envData + (envData.endsWith("\n") ? "" : "\n") + newLine + "\n";

  fs.writeFileSync(envPath, envData, "utf8");
  console.log("✅ Kite access token saved to .env");
};

export const getKiteInstance = () => {
  if (!dailyAccessToken) loadTokenFromDisk();
  return kc;
};