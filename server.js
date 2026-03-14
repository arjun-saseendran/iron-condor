import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import { exec } from "child_process";

// ─── Config & DB ──────────────────────────────────────────────────────────────
import { connectDatabases } from "./config/db.js";
import { loadTokenFromDB } from "./config/kiteConfig.js";
import { setIO as setSocketIO } from "./config/socket.js";

// ─── Routes ───────────────────────────────────────────────────────────────────
import authRoutes from "./routes/authRoutes.js";
import tradeRoutes from "./routes/ironCondorTradeRoutes.js";
import autoCondorRoutes from "./routes/autoCondorTradeRoutes.js";
import optionsRoutes from "./routes/optionChainRoutes.js";
import positionRoutes from "./routes/positionRoutes.js";
import condorRoutes from "./routes/dashboardRoutes.js";

// ─── Services ─────────────────────────────────────────────────────────────────
import { sendTelegramAlert } from "./services/telegramService.js";
import {
  initKiteLiveData,
  subscribeCondorToken,
} from "./services/kiteLiveData.js";
import { kiteSymbolToToken } from "./services/kiteSymbolMapper.js";

// ─── Engines ──────────────────────────────────────────────────────────────────
import { scanAndSyncOrders } from "./Engines/ironCondorEngine.js";
import {
  resetAutoCondorDay,
  autoMonitorTick,
  autoEnterIfNeeded,
} from "./Engines/autoCondorEngine.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import getActiveTradeModel from "./models/activeTradeModel.js";

// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ORIGINS = [
  "https://mariaalgo.online",
  "https://www.mariaalgo.online",
  "https://api.mariaalgo.online",
  process.env.CLIENT_ORIGIN || "http://localhost:5173",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ["GET", "POST"], credentials: true },
});
setSocketIO(io);
app.set("io", io);
io.on("connection", () => {});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/options", optionsRoutes);
app.use("/api/positions", positionRoutes);
app.use("/api/auto-condor", autoCondorRoutes);
app.use("/api/condor", condorRoutes);

// ─── Trade History ────────────────────────────────────────────────────────────
app.get("/api/history", async (req, res) => {
  try {
    const { getCondorTradePerformanceModel } =
      await import("./models/condorTradePerformanceModel.js");
    const history = await getCondorTradePerformanceModel()
      .find({}) // ✅ FIX: strategy field is never set on CondorPerf records — removed filter
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(
      history.map((h) => ({
        index: h.index,
        exitReason: h.exitReason,
        pnl: h.realizedPnL,
        createdAt: h.createdAt,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status", (_req, res) =>
  res.json({
    status: "Online",
    strategy: "Iron Condor",
    timestamp: new Date(),
  }),
);

// ─── Engine Stop (Kill Switch) ────────────────────────────────────────────────
// Stops the pm2 process immediately — does NOT touch open positions.
// Use from dashboard when you need to kill the bot safely.
// Open positions must be handled manually in Kite after stopping.
app.post("/api/engine/stop", async (_req, res) => {
  try {
    // Reply immediately so dashboard gets response before process dies
    res.json({
      success: true,
      message: "Exiting positions then stopping engine...",
    });

    // Exit all open positions first
    try {
      const ActiveTrade = getActiveTradeModel();
      const trade = await ActiveTrade.findOne({ status: { $ne: "COMPLETED" } });
      if (trade) {
        const { exitAllLegs } = await import("./Engines/ironCondorEngine.js");
        await exitAllLegs(trade, "MANUAL_STOP");
        console.log("✅ All legs exited before engine stop");
      }
    } catch (e) {
      console.error("❌ Exit legs failed on stop:", e.message);
      await sendTelegramAlert(
        `⚠️ <b>Exit before stop FAILED</b>\n${e.message}\n⚠️ Check Kite positions manually`,
      );
    }

    await sendTelegramAlert(
      "🔴 <b>Iron Condor Engine STOPPED</b>\nKill switch triggered from dashboard. All positions exited.",
    );

    setTimeout(() => {
      exec("pm2 stop iron-condor", (err) => {
        if (err) console.error("❌ pm2 stop failed:", err.message);
      });
    }, 1000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Enter opposite side (one-side → iron condor) ────────────────────────────
// Called from dashboard when oppositeSidePending=true and user clicks confirm
app.post("/api/trades/enter-opposite", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!trade) return res.status(404).json({ error: "No active trade" });
    if (!trade.oppositeSidePending)
      return res.status(400).json({ error: "No opposite side pending" });

    const {
      enterSpread,
      findReplacementSpread,
      buildKiteSymbol,
      cacheAndSubscribe,
      getSpotPrice,
      fetchFullOptionChain,
    } = await import("./Engines/ironCondorEngine.js");

    const oppSide = trade.oppositeSide;
    const spot = await getSpotPrice(trade.index);
    const strikes = await fetchFullOptionChain(trade.index, trade.expiry);
    const replacement = findReplacementSpread(
      strikes,
      spot,
      trade.index,
      oppSide,
    );
    const optType = oppSide === "call" ? "CE" : "PE";
    const newSellSym = buildKiteSymbol(
      trade.index,
      trade.expiry,
      replacement.sell.strike,
      optType,
    );
    const newBuySym = buildKiteSymbol(
      trade.index,
      trade.expiry,
      replacement.buy.strike,
      optType,
    );

    if (oppSide === "call") {
      cacheAndSubscribe(newSellSym, replacement.sell.callKey);
      cacheAndSubscribe(newBuySym, replacement.buy.callKey);
    } else {
      cacheAndSubscribe(newSellSym, replacement.sell.putKey);
      cacheAndSubscribe(newBuySym, replacement.buy.putKey);
    }

    // Confirmed from Kite — only after this update DB
    const newOrders = await enterSpread(
      newSellSym,
      newBuySym,
      trade.quantity,
      trade.index,
    );
    const newEntry = newOrders.actualNet;

    const upd = {
      positionType: "IRON_CONDOR",
      oppositeSidePending: false,
      oppositeSide: null,
      totalEntryPremium:
        (oppSide === "call" ? newEntry : trade.callSpreadEntryPremium) +
        (oppSide === "put" ? newEntry : trade.putSpreadEntryPremium),
    };
    if (oppSide === "call") {
      upd["symbols.callSell"] = newSellSym;
      upd["symbols.callBuy"] = newBuySym;
      upd["orderIds.callSell"] = newOrders.sellId;
      upd["orderIds.callBuy"] = newOrders.buyId;
      upd["callSpreadEntryPremium"] = newEntry;
    } else {
      upd["symbols.putSell"] = newSellSym;
      upd["symbols.putBuy"] = newBuySym;
      upd["orderIds.putSell"] = newOrders.sellId;
      upd["orderIds.putBuy"] = newOrders.buyId;
      upd["putSpreadEntryPremium"] = newEntry;
    }
    await ActiveTrade.updateOne({ _id: trade._id }, { $set: upd });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Mode switch ─────────────────────────────────────────────────────────────
app.post("/api/trades/mode", async (req, res) => {
  try {
    const { mode } = req.body;
    if (!["SEMI_AUTO", "FULL_AUTO"].includes(mode))
      return res
        .status(400)
        .json({ error: "mode must be SEMI_AUTO or FULL_AUTO" });
    const ActiveTrade = getActiveTradeModel();
    const trade = await ActiveTrade.findOne({ status: "ACTIVE" });
    if (!trade) return res.status(404).json({ error: "No active trade" });
    await ActiveTrade.updateOne({ _id: trade._id }, { $set: { mode } });
    await sendTelegramAlert(
      `🔄 <b>Mode switched to ${mode}</b> · ${trade.index}`,
    );
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
    if (!trade.firefightPending)
      return res.status(400).json({ error: "No firefight pending" });

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
    if (!trade.butterflyPending)
      return res.status(400).json({ error: "No butterfly pending" });
    // ✅ FIX: losingSide is stored in butterflySide field when butterflyPending is set.
    //         convertToButterfly requires losingSide — without it, wrong side gets exited.
    const losingSide = trade.butterflySide;
    if (!losingSide)
      return res
        .status(400)
        .json({ error: "butterflySide not set on trade — cannot convert" });

    const { convertToButterfly } =
      await import("./Engines/ironCondorEngine.js");
    await convertToButterfly(trade, losingSide);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Global error handlers ────────────────────────────────────────────────────
process.on("uncaughtException", async (err) => {
  console.error("💥 Uncaught:", err.message);
  try {
    await sendTelegramAlert(
      `💥 <b>Server Crash</b>\n<code>${err.message}</code>`,
    );
  } catch (_) {}
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("💥 Unhandled:", msg);
  try {
    await sendTelegramAlert(
      `⚠️ <b>Unhandled Rejection</b>\n<code>${msg}</code>`,
    );
  } catch (_) {}
});

// ─── Startup ──────────────────────────────────────────────────────────────────
const start = async () => {
  await connectDatabases();

  const token = await loadTokenFromDB();
  if (!token) {
    await sendTelegramAlert(
      "⚠️ <b>Kite token missing</b>\nVisit /api/auth/zerodha/login to authenticate",
    );
  }

  const PORT = process.env.PORT || 3002;
  server.listen(PORT, async () => {
    console.log(`🚀 Iron Condor Server · port ${PORT}`);
    await sendTelegramAlert("🦅 <b>Iron Condor Server Online ✅</b>");

    // Start Kite WebSocket live data feed
    initKiteLiveData();
    console.log("✅ Kite WebSocket ticker started");

    // ── Fast loop every 1 second — monitor + entry checks + live socket emit ──
    setInterval(async () => {
      try {
        await autoMonitorTick();
        await autoEnterIfNeeded();

        // Keep Kite ticker subscriptions fresh for active legs
        const ActiveTrade = getActiveTradeModel();
        const active = await ActiveTrade.findOne({ status: "ACTIVE" });
        if (active) {
          [
            active.symbols.callSell,
            active.symbols.callBuy,
            active.symbols.putSell,
            active.symbols.putBuy,
          ]
            .filter(Boolean)
            .forEach((sym) => {
              const tok = kiteSymbolToToken(sym);
              if (tok) subscribeCondorToken(tok);
            });
        }

        // Emit live dashboard data every tick using WebSocket prices — no REST call
        await scanAndSyncOrders();
      } catch (err) {
        console.error("❌ Main loop error:", err.message);
      }
    }, 1000);

    // ── Reconciliation loop every 60 seconds — Kite REST positions/orders sync ─
    // Live prices come from WebSocket (condorPrices{}) — no need to poll REST for P&L.
    // REST reconciliation runs once per minute only — for position cross-check.
    setInterval(async () => {
      try {
        const { reconcileKitePositions } =
          await import("./Engines/ironCondorEngine.js");
        await reconcileKitePositions();
      } catch (err) {
        console.error("❌ Reconcile loop error:", err.message);
      }
    }, 60_000);
  });
};

// ─── Cron: reset day state at 9:00 AM IST weekdays ───────────────────────────
cron.schedule("0 9 * * 1-5", () => resetAutoCondorDay(), {
  timezone: "Asia/Kolkata",
});

// ─── Cron: auto-disarm at 3:35 PM IST weekdays ───────────────────────────────
// Stops monitoring loop after market close — positions expire naturally on expiry day
// No positions are touched — only disarms the auto condor engine
cron.schedule("35 15 * * 1-5", () => resetAutoCondorDay(), {
  timezone: "Asia/Kolkata",
});

start();