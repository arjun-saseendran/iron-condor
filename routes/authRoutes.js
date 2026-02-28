import express from 'express';
import { getKiteInstance, setAccessToken } from '../services/kiteService.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Step 1: Redirect to Kite Login URL
router.get('/zerodha/login', (req, res) => {
  const kc = getKiteInstance();
  const loginUrl = kc.getLoginURL();
  res.redirect(loginUrl);
});

// Step 2: Handle the callback from Kite and generate the session
router.get('/zerodha/callback', async (req, res) => {
  const requestToken = req.query.request_token;
  
  if (!requestToken) {
    return res.status(400).json({ error: 'No request token found in URL.' });
  }

  const kc = getKiteInstance();

  try {
    // Exchange the request token for an access token
    const response = await kc.generateSession(requestToken, process.env.KITE_API_SECRET);
    
    // Save the access token to our service
    setAccessToken(response.access_token);
    
    res.status(200).json({ 
      status: 'success', 
      message: 'Logged in to Kite successfully!',
      access_token: response.access_token 
    });
  } catch (error) {
    console.error('❌ Kite Login Error:', error.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

export default router;