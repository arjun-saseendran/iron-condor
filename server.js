import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors'; // Added to allow your future React frontend to talk to this server
import connectDB from './config/db.js';
import tradeRoutes from './routes/tradeRoutes.js';
import { scanAndSyncOrders } from './services/orderMonitorService.js';
import { initTicker } from './services/tickerService.js';
import { sendTelegramAlert } from './services/telegramService.js';

dotenv.config();

const app = express();

// --- MIDDLEWARE ---
app.use(express.json());
const corsOptions = {
    origin: 'https://mariaalgo.online',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Origin'],
};

app.use(cors(corsOptions));
app.options('/{*path}', cors(corsOptions));

// --- DATABASE ---
connectDB();

// --- API ROUTES ---
app.use('/api/trades', tradeRoutes);

// Simple Health Check Route
app.get('/status', (req, res) => {
    res.json({ status: 'Online', timestamp: new Date() });
});

const PORT = process.env.PORT || 5000;

// --- START SERVER ---
const server = app.listen(PORT, async () => {
    console.log(`🚀 Iron-Condor Engine running on port ${PORT}`);
    
    try {
        // 1. Initialize Telegram (Optional: Send a "Bot Online" message)
        await sendTelegramAlert("🤖 <b>Iron-Condor Bot is now Online</b>\nSystem is standing by for Monday morning.");

        // 2. Initialize Kite Ticker (WebSockets)
        console.log("📡 Initializing Ticker Engine...");
        await initTicker();
        
        // 3. Start Order Detective (Background Scanner)
        // Runs every 60 seconds to detect entries or rolls from your mobile app
        console.log("⏱️ Starting background Order Detective (60s loop)...");
        setInterval(async () => {
            try {
                await scanAndSyncOrders();
            } catch (err) {
                console.error("❌ Detective Error Loop:", err.message);
            }
        }, 60000);

    } catch (err) {
        console.error("❌ CRITICAL STARTUP ERROR:", err.message);
        // Alert you on Telegram if the bot fails to start
        await sendTelegramAlert(`🚨 <b>Critical Startup Failure:</b>\n${err.message}`);
    }
});

// Graceful Shutdown (Stops the bot cleanly if you hit Ctrl+C)
process.on('SIGINT', () => {
    console.log("🛑 Shutting down server...");
    server.close(() => {
        console.log("Process terminated.");
        process.exit(0);
    });
});