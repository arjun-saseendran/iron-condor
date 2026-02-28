import express from 'express';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { loadTokenFromDisk } from './services/kiteService.js';
import { startTicker } from './services/tickerService.js';

import authRoutes from './routes/authRoutes.js';
import tradeRoutes from './routes/tradeRoutes.js';

dotenv.config();
connectDB(); 

const app = express();
const httpServer = createServer(app);

initSocket(httpServer);
app.use(express.json()); 

// MOUNTING: This makes all auth routes start with /api/auth/zerodha
app.use('/api/auth/zerodha', authRoutes);     
app.use('/api/trades', tradeRoutes);  

const PORT = process.env.PORT || 5000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Iron Condor engine online.' });
});

httpServer.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  loadTokenFromDisk();
});