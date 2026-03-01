import express from 'express';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { loadTokenFromDisk } from './services/kiteService.js';
import { startTicker } from './services/tickerService.js';

import { scanAndSyncOrders } from './services/orderMonitorService.js';
import { performZerodhaAutoLogin } from './services/kiteAutoLogin.js';

import authRoutes from './routes/authRoutes.js';
import tradeRoutes from './routes/tradeRoutes.js';
// ✅ ADDED MISSING IMPORT
import positionRoutes from './routes/positionRoutes.js'; 

dotenv.config();
connectDB(); 

const app = express();
const httpServer = createServer(app);

initSocket(httpServer);
app.use(express.json()); 

app.use('/api/auth/zerodha', authRoutes);     
app.use('/api/trades', tradeRoutes);  
// ✅ ADDED MISSING MOUNT
app.use('/api/positions', positionRoutes); 

const PORT = process.env.PORT || 5000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Iron Condor engine online.' });
});

httpServer.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  const token = loadTokenFromDisk();
  if (!token) {
      console.log("⚠️ No valid token found on disk. Initiating Auto-Login...");
      await performZerodhaAutoLogin();
  }

  startTicker();

  console.log("⏱️ Starting background order scanner (runs every 60s)...");
  setInterval(async () => {
      await scanAndSyncOrders();
  }, 60000); 
});