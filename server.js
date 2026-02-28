import express from 'express';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { loadTokenFromDisk } from './services/kiteService.js';
import { startTicker } from './services/tickerService.js';

// Route Imports
import authRoutes from './routes/authRoutes.js';
import tradeRoutes from './routes/tradeRoutes.js';

dotenv.config();
connectDB(); 

const app = express();
const httpServer = createServer(app);

initSocket(httpServer);

app.use(express.json()); 

// ==========================================
// FIXED: API ROUTE MOUNTING
// ==========================================
// Mounting at /api/auth/zerodha means all auth routes start here
app.use('/api/auth/zerodha', authRoutes);     
app.use('/api/trades', tradeRoutes);  

// Set to Port 5000 for Iron Condor
const PORT = process.env.PORT || 5000;

// 1-CLICK LOGIN REDIRECT
app.get('/', (req, res) => {
  const apiKey = process.env.KITE_API_KEY; 
  if (!apiKey) {
    return res.status(500).send("Please add KITE_API_KEY to your .env file!");
  }
  const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
  res.redirect(loginUrl);
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Trading Engine is online.' });
});

httpServer.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  const existingToken = loadTokenFromDisk();
  if (existingToken) {
    console.log('🔄 Session found! Reconnecting Kite Ticker...');
    try {
      await startTicker();
    } catch (err) {
      console.error('❌ Failed to auto-start ticker.');
    }
  }
});