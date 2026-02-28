import express from 'express';
import { getKiteInstance, setAccessToken } from '../services/kiteService.js';
import dotenv from 'dotenv';

dotenv.config();
const router = express.Router();

// FIXED URL: https://api.mariaalgo.online/api/auth/zerodha/login
router.get('/login', (req, res) => {
  const kc = getKiteInstance();
  const loginUrl = kc.getLoginURL();
  res.redirect(loginUrl);
});

// FIXED CALLBACK: https://api.mariaalgo.online/api/auth/zerodha/callback
router.get('/callback', async (req, res) => {
  const requestToken = req.query.request_token;
  if (!requestToken) return res.status(400).json({ error: 'No token found' });

  const kc = getKiteInstance();
  try {
    const response = await kc.generateSession(requestToken, process.env.KITE_API_SECRET);
    setAccessToken(response.access_token);
    res.status(200).json({ status: 'success', message: 'Kite Authenticated!' });
  } catch (error) {
    res.status(500).json({ error: 'Auth failed' });
  }
});

export default router;