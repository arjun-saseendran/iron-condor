import { KiteConnect } from 'kiteconnect';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Initialize the Kite Connect instance
const kc = new KiteConnect({
  api_key: process.env.KITE_API_KEY
});

// We will save the token to a file named 'kite_token.txt' in your root folder
const TOKEN_FILE_PATH = path.join(process.cwd(), 'kite_token.txt');

let dailyAccessToken = null;

// ==========================================
// LOAD TOKEN FROM DISK (ON SERVER START)
// ==========================================
export const loadTokenFromDisk = () => {
  try {
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      const savedToken = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
      if (savedToken) {
        dailyAccessToken = savedToken;
        kc.setAccessToken(savedToken);
        console.log(`✅ Loaded saved Kite Access Token from disk.`);
        return savedToken;
      }
    }
  } catch (err) {
    console.error('❌ Error reading token from disk:', err.message);
  }
  return null;
};

// ==========================================
// SET AND SAVE NEW TOKEN (ON LOGIN)
// ==========================================
export const setAccessToken = (token) => {
  dailyAccessToken = token;
  kc.setAccessToken(token);
  
  // Save to physical file so it survives server restarts
  fs.writeFileSync(TOKEN_FILE_PATH, token, 'utf8');
  console.log('✅ New Kite Access Token saved securely to disk.');
};

export const getAccessToken = () => {
  if (!dailyAccessToken) {
    return loadTokenFromDisk();
  }
  return dailyAccessToken;
};

export const getKiteInstance = () => {
  // Ensure we have loaded the token into the instance if it exists
  if (!dailyAccessToken) loadTokenFromDisk();
  return kc;
};