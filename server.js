import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";

// ─── Config & Routes ──────────────────────────────────────────────────────────
import { connectDatabases }   from "./config/db.js";
import tradeRoutes            from "./routes/ironCondorTradeRoutes.js";
import autoCondorRoutes       from "./routes/autoCondorRoutes.js";
import optionsRoutes          from "./routes/optionChainRoutes.js";
import positionRoutes         from "./routes/ironCondorPositionRoutes.js";

// ─── Models ───────────────────────────────────────────────────────────────────
import getActiveTradeModel    from "./models/ironCondorActiveTradeModel.js";

// ─── Services & Strategy ──────────────────────────────────────────────────────
import { scanAndSyncOrders, condorPrices } from "./Engines/ironCondorEngine.js";
import { resetAutoCondorDay }              from "./Engines/autoCondorEngine.js";
import { loadTokenFromDisk }               from "./config/kiteConfig.js";
import { setUpstoxAccessToken }            from "./config/upstoxConfig.js";
import { sendTelegramAlert }               from "./services/telegramService.js";

// ─── Live Data ────────────────────────────────────────────────────────────────
import { initUpstoxLiveData, subscribeCondorSymbol } from "./services/upstoxLiveData.js";

// ─── Symbol mapper ────────────────────────────────────────────────────────────
import { kiteToUpstoxSymbol } from "./services/upstoxSymbolMapper.js";

// ─── Socket shared module ─────────────────────────────────────────────────────
import { setIO as setSocketIO } from "./config/socket.js";

// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:         [process.env.CLIENT_ORIGIN || "http://localhost:5173", "http://localhost:3000"],
  credentials:    true,
  methods:        ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      [process.env.CLIENT_ORIGIN || "http://localhost:5173", "http://localhost:3000"],
    methods:     ["GET", "POST"],
    credentials: true,
  },
});

setSocketIO(io);

io.on("connection", (_socket) => {});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use("/api/trades",      tradeRoutes);
app.use("/api/options",     optionsRoutes);
app.use("/api/positions",   positionRoutes);
app.use("/api/auto-condor", autoCondorRoutes);

// ── Iron Condor Live Positions ─────────────────────────────────────────────────
app.get("/api/condor/positions", async (req, res) => {
  try {
    const ActiveTrade = getActiveTradeModel();
    const { getCondorTradePerformanceModel } = await import("./models/condorTradePerformanceModel.js");
    const CondorPerf  = getCondorTradePerformanceModel();

    const activeTrade = await ActiveTrade.findOne({ status: "ACTIVE" });

    if (!activeTrade) {
      const lastTrade = await ActiveTrade.findOne({ status: "COMPLETED" }).sort({ updatedAt: -1 });
      if (!lastTrade) return res.json([]);
      const lastPerf = await CondorPerf.findOne({ activeTradeId: lastTrade._id });
      return res.json([{
        status:     "COMPLETED",
        index:      lastTrade.index,
        totalPnL:   lastPerf?.realizedPnL?.toFixed(2) || "0.00",
        exitReason: lastPerf?.exitReason || "COMPLETED",
        quantity:   lastTrade.lotSize,
        call: { entry: lastTrade.callSpreadEntryPremium?.toFixed(2) || "0.00", current: "0.00", sl: "0.00", firefightLevel: "0.00" },
        put:  { entry: lastTrade.putSpreadEntryPremium?.toFixed(2)  || "0.00", current: "0.00", sl: "0.00", firefightLevel: "0.00" },
      }]);
    }

    const idx = activeTrade.index;
    const getLtp = (sym) => sym ? (condorPrices[kiteToUpstoxSymbol(sym, idx)] || 0) : 0;

    const currentCallNet = activeTrade.symbols.callSell
      ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy)) : 0;
    const currentPutNet = activeTrade.symbols.putSell
      ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy)) : 0;

    const totalPnL =
      ((activeTrade.callSpreadEntryPremium - currentCallNet) +
       (activeTrade.putSpreadEntryPremium  - currentPutNet)) * activeTrade.lotSize;

    const buffer = activeTrade.bufferPremium || 0;
    const spreadDist = idx === "SENSEX"
      ? parseInt(process.env.SENSEX_SPREAD_DISTANCE || "500")
      : parseInt(process.env.NIFTY_SPREAD_DISTANCE  || "150");
    const maxSpreadSL = spreadDist / 2;
    const callSL = Math.min((activeTrade.callSpreadEntryPremium * 4) + buffer, maxSpreadSL);
    const putSL  = Math.min((activeTrade.putSpreadEntryPremium  * 4) + buffer, maxSpreadSL);
    const callFirefightLevel = activeTrade.callSpreadEntryPremium * 0.30;
    const putFirefightLevel  = activeTrade.putSpreadEntryPremium  * 0.30;

    res.json([{
      index:         activeTrade.index,
      totalPnL:      totalPnL.toFixed(2),
      quantity:      activeTrade.lotSize,
      bufferPremium: buffer.toFixed(2),
      isButterfly:   activeTrade.isIronButterfly || false,
      spreadSLCount: activeTrade.spreadSLCount   || 0,
      circleNumber:  activeTrade.circleNumber    || 1,
      butterflySL:   ((activeTrade.totalEntryPremium * 3) + buffer).toFixed(2),
      call: { entry: activeTrade.callSpreadEntryPremium.toFixed(2), current: currentCallNet.toFixed(2), sl: callSL.toFixed(2), firefightLevel: callFirefightLevel.toFixed(2) },
      put:  { entry: activeTrade.putSpreadEntryPremium.toFixed(2),  current: currentPutNet.toFixed(2),  sl: putSL.toFixed(2),  firefightLevel: putFirefightLevel.toFixed(2)  },
    }]);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trade History ──────────────────────────────────────────────────────────────
app.get("/api/history", async (req, res) => {
  try {
    const { getCondorTradePerformanceModel } = await import("./models/condorTradePerformanceModel.js");
    const CondorPerf = getCondorTradePerformanceModel();
    const history = await CondorPerf.find({ strategy: "IRON_CONDOR" })
      .sort({ createdAt: -1 })
      .limit(20);

    const combined = history.map((h) => ({
      symbol:     h.index || h.symbol,
      exitReason: h.exitReason,
      pnl:        h.realizedPnL ?? h.pnl,
      strategy:   "IRON_CONDOR",
      notes:      h.notes,
      createdAt:  h.createdAt,
    }));

    res.json(combined);
  } catch (err) {
    console.error("❌ /api/history error:", err.message);
    res.status(500).json({ error: "History fetch failed" });
  }
});

app.get("/status", (req, res) =>
  res.json({ status: "Online", strategy: "Iron Condor", timestamp: new Date() })
);

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────
process.on("uncaughtException", async (err) => {
  console.error("💥 Uncaught Exception:", err.message);
  try { await sendTelegramAlert(`💥 <b>Iron Condor Server Crash</b>\n<code>${err.message}</code>`); } catch (_) {}
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("💥 Unhandled Rejection:", msg);
  try { await sendTelegramAlert(`⚠️ <b>Unhandled Rejection</b>\n<code>${msg}</code>`); } catch (_) {}
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDatabases();

    await loadTokenFromDisk();
    if (process.env.UPSTOX_ACCESS_TOKEN) {
      setUpstoxAccessToken(process.env.UPSTOX_ACCESS_TOKEN);
      console.log("✅ Upstox token loaded");
    }

    const PORT = process.env.PORT || 3002;
    server.listen(PORT, async () => {
      console.log(`🚀 Iron Condor Server Online · port ${PORT}`);
      await sendTelegramAlert("🦅 <b>Iron Condor Server Online! ✅</b>");

      if (process.env.UPSTOX_ACCESS_TOKEN) {
        await initUpstoxLiveData();
        console.log("✅ Upstox live data started (Iron Condor)");
      } else {
        console.warn("⚠️ UPSTOX_ACCESS_TOKEN missing — Iron Condor will not receive live data");
      }

      setInterval(async () => {
        try {
          await scanAndSyncOrders();

          const ActiveTrade = getActiveTradeModel();
          const active = await ActiveTrade.findOne({ status: "ACTIVE" });
          if (active) {
            const idx = active.index;
            [active.symbols.callSell, active.symbols.callBuy,
             active.symbols.putSell,  active.symbols.putBuy]
              .filter(Boolean)
              .forEach(kite => subscribeCondorSymbol(kiteToUpstoxSymbol(kite, idx)));
          }
        } catch (err) {
          console.error("❌ scanAndSyncOrders error:", err.message);
        }
      }, 60000);
    });

  } catch (err) {
    console.error("💥 Fatal startup error:", err);
    process.exit(1);
  }
};

// ─── CRON — Reset at 9:00 AM IST every weekday ───────────────────────────────
cron.schedule("0 9 * * 1-5", () => {
  resetAutoCondorDay();
}, { timezone: "Asia/Kolkata" });

start();
