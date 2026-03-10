import "dotenv/config";
import express from "express";
import http    from "http";
import { Server } from "socket.io";
import cors   from "cors";
import cron   from "node-cron";

// ─── Config & DB ──────────────────────────────────────────────────────────────
import { connectDatabases }  from "./config/db.js";
import { loadTokenFromDisk } from "./config/kiteConfig.js";
import { setIO as setSocketIO }  from "./config/socket.js";
import { getKiteInstance }       from "./config/kiteConfig.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import getActiveTradeModel from "./models/ironCondorActiveTradeModel.js";

// ─── Routes ───────────────────────────────────────────────────────────────────
import tradeRoutes     from "./routes/ironCondorTradeRoutes.js";
import autoCondorRoutes from "./routes/autoCondorRoutes.js";
import optionsRoutes   from "./routes/optionChainRoutes.js";
import positionRoutes  from "./routes/ironCondorPositionRoutes.js";
import condorRoutes    from "./routes/condorDashboardRoutes.js";

// ─── Services ─────────────────────────────────────────────────────────────────
import { sendTelegramAlert } from "./services/telegramService.js";
import { initKiteLiveData, subscribeCondorToken } from "./services/kiteLiveData.js";
import { kiteSymbolToToken } from "./services/kiteSymbolMapper.js";

// ─── Engines ──────────────────────────────────────────────────────────────────
import {
  scanAndSyncOrders,
} from "./Engines/ironCondorEngine.js";
import {
  resetAutoCondorDay,
  autoMonitorTick,
  autoEnterIfNeeded,
} from "./Engines/autoCondorEngine.js";

// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ORIGINS = [
  "https://mariaalgo.online",
  "https://www.mariaalgo.online",
  "https://api.mariaalgo.online",
  process.env.CLIENT_ORIGIN || "http://localhost:5173",
  "http://localhost:3000",
];

app.use(cors({ origin: ORIGINS, credentials: true, methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json());

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: ORIGINS, methods: ["GET","POST"], credentials: true } });
setSocketIO(io);
io.on("connection", () => {});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/trades",      tradeRoutes);
app.use("/api/options",     optionsRoutes);
app.use("/api/positions",   positionRoutes);
app.use("/api/auto-condor", autoCondorRoutes);
app.use("/api/condor",      condorRoutes);

// ─── Trade History ────────────────────────────────────────────────────────────
app.get("/api/history", async (req, res) => {
  try {
    const { getCondorTradePerformanceModel } = await import("./models/condorTradePerformanceModel.js");
    const history = await getCondorTradePerformanceModel()
      .find({}) // ✅ FIX: strategy field is never set on CondorPerf records — removed filter
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(history.map(h => ({
      index:      h.index,
      exitReason: h.exitReason,
      pnl:        h.realizedPnL,
      createdAt:  h.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status", (_req, res) => res.json({ status: "Online", strategy: "Iron Condor", timestamp: new Date() }));

// ─── Mode switch ─────────────────────────────────────────────────────────────
app.post("/api/trades/mode", async (req, res) => {
  try {
    const { mode } = req.body;
    if (!["SEMI_AUTO","FULL_AUTO"].includes(mode))
      return res.status(400).json({ error: "mode must be SEMI_AUTO or FULL_AUTO" });
    const ActiveTrade = getActiveTradeModel();
    const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!trade) return res.status(404).json({ error: "No active trade" });
    await ActiveTrade.updateOne({ _id: trade._id }, { $set: { mode } });
    await sendTelegramAlert(`🔄 <b>Mode switched to ${mode}</b> · ${trade.index}`);
    res.json({ success: true, mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Semi-auto one-click firefight ────────────────────────────────────────────
app.post("/api/trades/firefight", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!trade) return res.status(404).json({ error: "No active trade" });
    if (!trade.firefightPending) return res.status(400).json({ error: "No firefight pending" });

    const { executeFirefight } = await import("./Engines/ironCondorEngine.js");
    await executeFirefight(trade, trade.firefightSide);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Semi-auto one-click butterfly ────────────────────────────────────────────
app.post("/api/trades/butterfly", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!trade) return res.status(404).json({ error: "No active trade" });
    if (!trade.butterflyPending) return res.status(400).json({ error: "No butterfly pending" });
    // ✅ FIX: losingSide is stored in butterflySide field when butterflyPending is set.
    //         convertToButterfly requires losingSide — without it, wrong side gets exited.
    const losingSide = trade.butterflySide;
    if (!losingSide) return res.status(400).json({ error: "butterflySide not set on trade — cannot convert" });

    const { convertToButterfly } = await import("./Engines/ironCondorEngine.js");
    await convertToButterfly(trade, losingSide);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Global error handlers ────────────────────────────────────────────────────
process.on("uncaughtException", async (err) => {
  console.error("💥 Uncaught:", err.message);
  try { await sendTelegramAlert(`💥 <b>Server Crash</b>\n<code>${err.message}</code>`); } catch (_) {}
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("💥 Unhandled:", msg);
  try { await sendTelegramAlert(`⚠️ <b>Unhandled Rejection</b>\n<code>${msg}</code>`); } catch (_) {}
});

// ─── Startup ──────────────────────────────────────────────────────────────────
const start = async () => {
  await connectDatabases();
  await loadTokenFromDisk();

  const PORT = process.env.PORT || 3002;
  server.listen(PORT, async () => {
    console.log(`🚀 Iron Condor Server · port ${PORT}`);
    await sendTelegramAlert("🦅 <b>Iron Condor Server Online ✅</b>");

    // Start Kite WebSocket live data feed
    initKiteLiveData();
    console.log("✅ Kite WebSocket ticker started");

    // ── Fast loop every 1 second — monitor + entry checks ───────────────────
    setInterval(async () => {
      try {
        await autoMonitorTick();
        await autoEnterIfNeeded();

        // Keep Kite ticker subscriptions fresh for active legs
        const ActiveTrade = getActiveTradeModel();
        const active = await ActiveTrade.findOne({ status: "ACTIVE" });
        if (active) {
          [active.symbols.callSell, active.symbols.callBuy, active.symbols.putSell, active.symbols.putBuy]
            .filter(Boolean)
            .forEach(sym => {
              const tok = kiteSymbolToToken(sym);
              if (tok) subscribeCondorToken(tok);
            });
        }
      } catch (err) {
        console.error("❌ Main loop error:", err.message);
      }
    }, 1000);

    // ── Slow loop every 5 seconds — Kite position/order sync ─────────────────
    // ✅ FIX: scanAndSyncOrders fetches Kite REST API (positions + orders).
    //         Running it every 1s = 60 REST calls/min — unnecessary and rate-limit risky.
    //         5s is sufficient for P&L display and SL cross-check.
    setInterval(async () => {
      try {
        await scanAndSyncOrders();
      } catch (err) {
        console.error("❌ Scan loop error:", err.message);
      }
    }, 5000);
  });
};

// ─── Cron: reset day state at 9:00 AM IST weekdays ───────────────────────────
cron.schedule("0 9 * * 1-5", () => resetAutoCondorDay(), { timezone: "Asia/Kolkata" });

start();