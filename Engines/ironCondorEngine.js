import { getKiteInstance } from '../config/kiteConfig.js';
import { getLTP } from '../config/upstoxConfig.js';
import { getIO } from '../config/socket.js';
import { sendCondorAlert } from '../services/telegramService.js';
import { executeMarketExit, executeMarginSafeEntry } from '../services/IronCodorOrderService.js';
import { kiteToUpstoxSymbol, getUpstoxIndexSymbol } from '../services/upstoxSymbolMapper.js';
import getActiveTradeModel from '../models/ironCondorActiveTradeModel.js';
import { getCondorTradePerformanceModel } from '../models/condorTradePerformanceModel.js';
import dotenv from 'dotenv';

const ActiveTrade      = () => getActiveTradeModel();
const TradePerformance = () => getCondorTradePerformanceModel();

const emitLog = (msg, level = "info") => {
  console.log(msg);
  const io = getIO();
  if (io) io.emit("trade_log", { msg, level, strategy: "CONDOR", time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) });
};

dotenv.config();

// ==========================================
// 🧠 1. STATE & CACHE MANAGER
// ==========================================
export const condorPrices = {};
let lastScanTime = 0;

export const updateCondorPrice = (symbol, price) => {
    condorPrices[symbol] = price;
};

const getActiveIndexForToday = () => {
    const day = new Date().getDay();
    if (day === 1 || day === 2) return 'NIFTY';
    if (day === 3 || day === 4) return 'SENSEX';
    return null;
};

const extractBaseSymbol = (symbol) => {
    if (!symbol) return null;
    const match = symbol.match(/^(.+?)(\d+)(CE|PE)$/);
    return match ? { base: match[1], strike: parseInt(match[2]), type: match[3] } : null;
};

const getSpreadDistance = (index) =>
    index === 'SENSEX'
        ? parseInt(process.env.SENSEX_SPREAD_DISTANCE || 500)
        : parseInt(process.env.NIFTY_SPREAD_DISTANCE  || 150);


// ==========================================
// 💰 2. FETCH CYCLE BUFFER FROM MONGODB
//
// STRATEGY CYCLE DEFINITION
// ─────────────────────────
// A "cycle" is the sequence of Iron Condor attempts since the last STOP_LOSS_HIT.
// Walk newest-first through TradePerformance records for this index.
// Stop at the first STOP_LOSS_HIT — everything before that is a prior cycle.
//
// What counts as buffer (booked profit)?
//   • PROFIT_TARGET exits  → full realizedPnL
//   • FIREFIGHT exits      → the portion of premium that was locked in during
//                            the firefight roll (stored as firefightBookedPnL)
//   • MANUAL_CLOSE exits   → full realizedPnL
//
// Buffer is expressed in POINTS = totalBookedProfit / lotSize
// so it can be added directly to premium-based SL thresholds.
//
// The "Iron Condor circle" (which attempt we are in) is determined by counting
// how many STOP_LOSS_HIT records exist for this index — that is the circle number.
// ==========================================
const fetchHistoricalBuffer = async (index, lotSize) => {
    try {
        const recentTrades = await TradePerformance().find({ index })
            .sort({ createdAt: -1 })
            .limit(20);

        if (!recentTrades || recentTrades.length === 0) {
            emitLog(`ℹ️ No trade history for ${index}. Buffer = 0`, "info");
            return { bufferPoints: 0, circleNumber: 1 };
        }

        // Count total SL hits to know which circle we are in (1-based)
        const totalSLHits = recentTrades.filter(t => t.exitReason === 'STOP_LOSS_HIT').length;
        const circleNumber = totalSLHits + 1; // current circle = next after last SL

        let cycleProfit = 0;
        for (const trade of recentTrades) {
            if (trade.exitReason === 'STOP_LOSS_HIT') {
                emitLog(`🛑 Buffer boundary: SL hit on trade ${trade.activeTradeId} (${trade.createdAt.toDateString()}). Stopping.`, "info");
                break;
            }
            if (
                trade.exitReason === 'PROFIT_TARGET' ||
                trade.exitReason === 'MANUAL_CLOSE'  ||
                trade.exitReason === 'FIREFIGHT'
            ) {
                // For firefight exits use the specific locked premium if available,
                // otherwise fall back to realizedPnL
                const contribution = trade.firefightBookedPnL ?? trade.realizedPnL;
                cycleProfit += contribution;
                emitLog(`  ✅ Including trade ${trade.activeTradeId} (${trade.exitReason}): +₹${contribution.toFixed(2)}`, "info");
            }
        }

        const bufferPoints = Math.max(0, cycleProfit / lotSize);
        emitLog(`💰 Cycle buffer for ${index} [Circle #${circleNumber}]: ₹${cycleProfit.toFixed(2)} = ${bufferPoints.toFixed(2)} pts`, "info");

        if (bufferPoints > 0) {
            sendCondorAlert(
                `💰 <b>Buffer Loaded — Circle #${circleNumber}</b>\n` +
                `Index: ${index}\n` +
                `Booked profit since last SL: ₹${cycleProfit.toFixed(2)}\n` +
                `Buffer Points: ${bufferPoints.toFixed(2)}`
            );
        } else {
            emitLog(`ℹ️ No profits in current cycle. Buffer = 0`, "info");
        }

        return { bufferPoints, circleNumber };
    } catch (err) {
        emitLog(`❌ Error fetching historical buffer: ${err.message}`, "error");
        return { bufferPoints: 0, circleNumber: 1 };
    }
};


// ==========================================
// 🛡️ 3. LIVE RISK & DECAY MONITOR
//
// STOP LOSS LOGIC SUMMARY
// ───────────────────────
// Spread distance:   NIFTY = 150 pts | SENSEX = 500 pts
//
// ── Standard Iron Condor ──
//   Example entry:  callNet = 6,  putNet = 6,  totalNet = 10 (discount due to overlap)
//
//   Iron Condor max loss (gap scenario only — do NOT auto-exit):
//     maxLoss = spreadDistance - totalEntryPremium + bufferPremium
//
//   Per-spread SL (normal market, auto-exit one side):
//     Firefight threshold = 70% profit on either spread = entryPremium × 0.30
//     spreadSL = (entryPremium × 4) + firefightBookedBuffer   ← 4× the spread entry
//     Hard cap: spreadSL must never exceed spreadDistance / 2  (= 75 for NIFTY, 250 for SENSEX)
//
//   RESET rule (one spread SL hit):
//     • Exit only the breached side (1 spread SL consumed)
//     • Keep the healthy side open
//     • Reload buffer from MongoDB → this is now a new circle
//     • Enter a fresh spread on the SL-hit side (handled manually on Kite;
//       scanAndSyncOrders will detect it and create a new ActiveTrade)
//     • If 2 spread SLs hit (both sides) → exit ALL positions (max loss)
//
// ── Iron Butterfly (defense mode) ──
//   Triggered when spot reaches a short strike.
//   The opposite side is rolled to the same ATM strike → 4-leg butterfly.
//
//   Butterfly SL = totalIronCondorPremium × 3 + bufferPremium
//     (uses original Iron Condor combined premium, NOT the butterfly roll premium)
//
// ── Gap Scenario (market opens beyond short strike) ──
//   Max loss is naturally capped by spread width.
//   Do NOT auto-exit. Hold till expiry or manual close.
//   (No changes to automated active/exit logic — this is strategy documentation only.)
// ==========================================
export const monitorCondorLevels = async () => {
    const activeTrade = await ActiveTrade().findOne({ status: 'ACTIVE' });
    if (!activeTrade) return;

    const idx      = activeTrade.index;
    const getLtp   = (sym) => sym ? condorPrices[kiteToUpstoxSymbol(sym, idx)] || 0 : 0;
    const spotLTP  = condorPrices[getUpstoxIndexSymbol(idx)] || 0;
    const spread   = getSpreadDistance(idx);

    const currentCallNet = activeTrade.symbols.callSell
        ? Math.abs(getLtp(activeTrade.symbols.callSell) - getLtp(activeTrade.symbols.callBuy))
        : 0;
    const currentPutNet = activeTrade.symbols.putSell
        ? Math.abs(getLtp(activeTrade.symbols.putSell) - getLtp(activeTrade.symbols.putBuy))
        : 0;

    let stateChanged = false;
    const {
        isIronButterfly,
        tradeType,
        callSpreadEntryPremium,
        putSpreadEntryPremium,
        totalEntryPremium,
        bufferPremium,          // booked firefight/profit buffer in points
        spreadSLCount,          // how many spread SLs consumed this circle (0, 1, or 2)
    } = activeTrade;

    // ── Firefight thresholds (70% profit = price at 30% of entry) ──
    const callFirefightLevel = callSpreadEntryPremium * 0.30;
    const putFirefightLevel  = putSpreadEntryPremium  * 0.30;

    // ── Per-spread SL: 4× entry premium + booked firefight buffer ──
    // Hard cap = half the spread distance (max possible loss on one leg)
    const rawCallSL = (callSpreadEntryPremium * 4) + bufferPremium;
    const rawPutSL  = (putSpreadEntryPremium  * 4) + bufferPremium;
    const maxSpreadSL = spread / 2; // e.g. 75 for NIFTY, 250 for SENSEX
    const callSL = Math.min(rawCallSL, maxSpreadSL);
    const putSL  = Math.min(rawPutSL,  maxSpreadSL);

    // ── Iron Butterfly SL: original Iron Condor total premium × 3 + buffer ──
    const butterflySL = (totalEntryPremium * 3) + bufferPremium;

    // ── Iron Condor max loss (gap — informational only, no auto-exit) ──
    const icMaxLoss = spread - totalEntryPremium + bufferPremium;


    // --- 🎯 FIREFIGHT BANNER: 70% profit on either spread ---
    if (
        !activeTrade.alertsSent.call70Decay &&
        tradeType !== 'PUT_SPREAD' &&
        currentCallNet > 0 &&
        currentCallNet <= callFirefightLevel
    ) {
        sendCondorAlert(
            `🟢 <b>FIREFIGHT BANNER: ${idx} CALL 70% PROFIT</b>\n` +
            `Entry: ₹${callSpreadEntryPremium.toFixed(2)}\n` +
            `Firefight Level (30%): ₹${callFirefightLevel.toFixed(2)}\n` +
            `Current: ₹${currentCallNet.toFixed(2)}\n` +
            `Radar Activated — scanning for inward roll.`
        );
        activeTrade.alertsSent.call70Decay = true;
        stateChanged = true;
    }

    if (
        !activeTrade.alertsSent.put70Decay &&
        tradeType !== 'CALL_SPREAD' &&
        currentPutNet > 0 &&
        currentPutNet <= putFirefightLevel
    ) {
        sendCondorAlert(
            `🟢 <b>FIREFIGHT BANNER: ${idx} PUT 70% PROFIT</b>\n` +
            `Entry: ₹${putSpreadEntryPremium.toFixed(2)}\n` +
            `Firefight Level (30%): ₹${putFirefightLevel.toFixed(2)}\n` +
            `Current: ₹${currentPutNet.toFixed(2)}\n` +
            `Radar Activated — scanning for inward roll.`
        );
        activeTrade.alertsSent.put70Decay = true;
        stateChanged = true;
    }

    // --- ⚠️ IRON BUTTERFLY DEFENSE: spot reaches short strike ATM ---
    const callStrike = extractBaseSymbol(activeTrade.symbols.callSell)?.strike;
    const putStrike  = extractBaseSymbol(activeTrade.symbols.putSell)?.strike;

    if (spotLTP && !isIronButterfly) {
        if (callStrike && spotLTP >= callStrike && !activeTrade.alertsSent.callDefense) {
            sendCondorAlert(
                `⚠️ <b>IRON BUTTERFLY TRIGGER: ${idx} CALL ATM</b>\n` +
                `Spot (${spotLTP}) reached Short Call Strike (${callStrike}).\n` +
                `Scanning to roll PUT side to ATM → Iron Butterfly conversion...`
            );
            activeTrade.alertsSent.callDefense = true;
            stateChanged = true;
        } else if (putStrike && spotLTP <= putStrike && !activeTrade.alertsSent.putDefense) {
            sendCondorAlert(
                `⚠️ <b>IRON BUTTERFLY TRIGGER: ${idx} PUT ATM</b>\n` +
                `Spot (${spotLTP}) reached Short Put Strike (${putStrike}).\n` +
                `Scanning to roll CALL side to ATM → Iron Butterfly conversion...`
            );
            activeTrade.alertsSent.putDefense = true;
            stateChanged = true;
        }
    }

    if (stateChanged) await activeTrade.save();

    // --- 📡 RADAR SCANNER (throttled to every 5 seconds) ---
    if (
        (activeTrade.alertsSent.call70Decay  ||
         activeTrade.alertsSent.put70Decay   ||
         activeTrade.alertsSent.callDefense  ||
         activeTrade.alertsSent.putDefense)  &&
        !isIronButterfly && spotLTP
    ) {
        if (Date.now() - lastScanTime > 5000) {
            lastScanTime = Date.now();
            await scanForRoll(activeTrade, spotLTP);
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // STOP LOSS EVALUATION
    // ──────────────────────────────────────────────────────────────────
    let triggerExit = false;
    let exitReason  = '';
    let slHitSide   = null;
    let isFullExit  = false; // true = exit all 4 legs; false = exit 1 spread only

    if (isIronButterfly) {
        // ── IRON BUTTERFLY SL ──
        // Use original Iron Condor total entry premium (not butterfly roll premium)
        const currentTotalValue = currentCallNet + currentPutNet;
        if (currentTotalValue >= butterflySL) {
            triggerExit = true;
            isFullExit  = true;
            exitReason  = `Iron Butterfly SL Hit (Limit: ₹${butterflySL.toFixed(2)} | Current: ₹${currentTotalValue.toFixed(2)})`;
        }
    } else {
        // ── STANDARD CONDOR: per-spread SL ──
        const currentSLCount = spreadSLCount || 0;

        if (tradeType !== 'PUT_SPREAD' && currentCallNet >= callSL) {
            slHitSide  = 'CALL';
            triggerExit = true;
            exitReason  = `CALL Spread SL Hit #${currentSLCount + 1} (Current: ₹${currentCallNet.toFixed(2)} | Limit: ₹${callSL.toFixed(2)})`;

            // 2nd spread SL = exit everything (max loss scenario)
            isFullExit = (currentSLCount + 1) >= 2;

        } else if (tradeType !== 'CALL_SPREAD' && currentPutNet >= putSL) {
            slHitSide   = 'PUT';
            triggerExit = true;
            exitReason  = `PUT Spread SL Hit #${currentSLCount + 1} (Current: ₹${currentPutNet.toFixed(2)} | Limit: ₹${putSL.toFixed(2)})`;

            isFullExit = (currentSLCount + 1) >= 2;
        }
    }

    // ── GAP PROTECTION ──
    // If spot has blown through a short strike, max loss is capped by spread width.
    // Suppress auto-exit — hold till expiry or manual close.
    // (No automated exit logic changed — this is purely a suppression guard.)
    if (triggerExit && spotLTP > 0) {
        const callShortStr = extractBaseSymbol(activeTrade.symbols.callSell)?.strike;
        const putShortStr  = extractBaseSymbol(activeTrade.symbols.putSell)?.strike;
        const isGap = callShortStr && putShortStr &&
            (spotLTP > callShortStr * 1.005 || spotLTP < putShortStr * 0.995);

        if (isGap) {
            if (!activeTrade.alertsSent?.gapAlert) {
                const maxLoss = icMaxLoss;
                sendCondorAlert(
                    `⚡ <b>GAP SCENARIO — SL SUPPRESSED: ${idx}</b>\n` +
                    `Spot ${spotLTP} breached short strike.\n` +
                    `Max capped loss: ₹${(maxLoss * activeTrade.lotSize).toFixed(0)}\n` +
                    `Formula: Spread(${spread}) - NetPremium(${totalEntryPremium.toFixed(2)}) + Buffer(${bufferPremium.toFixed(2)})\n` +
                    `⏳ Holding position till expiry.`
                );
                activeTrade.alertsSent.gapAlert = true;
                await activeTrade.save();
            }
            return; // suppress SL exit — strategy decision, no automated change
        }
    }

    // ── EXECUTE EXIT ──
    if (triggerExit && activeTrade.status === 'ACTIVE') {
        activeTrade.status = 'EXITING';
        const currentSLCount = (activeTrade.spreadSLCount || 0) + 1;
        activeTrade.spreadSLCount = currentSLCount;
        await activeTrade.save();

        sendCondorAlert(
            `🚨 <b>STOP LOSS TRIGGERED: ${idx}</b>\n` +
            `Reason: ${exitReason}\n` +
            `Exit Type: ${isFullExit ? '🔴 FULL EXIT (both spreads)' : '🟡 PARTIAL EXIT (one spread)'}\n` +
            `Executing exit...`
        );

        await executeMarketExit(activeTrade, isFullExit ? 'FULL' : slHitSide);

        if (isFullExit) {
            // Both spreads exited — mark entire trade COMPLETED
            activeTrade.status    = 'COMPLETED';
            activeTrade.slHitSide = slHitSide;
            await activeTrade.save();

            sendCondorAlert(
                `🔴 <b>MAX LOSS HIT: ${idx} — Both Spreads Exited</b>\n` +
                `Circle complete. New circle will begin on next Kite entry.\n` +
                `Buffer will be recalculated from MongoDB history.`
            );
        } else {
            // One spread exited — RESET: keep healthy side, await new spread entry
            activeTrade.status    = 'COMPLETED';
            activeTrade.slHitSide = slHitSide;
            await activeTrade.save();

            sendCondorAlert(
                `🟡 <b>RESET: ${idx} — ${slHitSide} Spread Exited (SL #${currentSLCount})</b>\n` +
                `Healthy side remains open.\n` +
                `When you enter a new ${slHitSide} spread on Kite, the bot will detect it\n` +
                `and reload buffer from MongoDB (circle-aware).\n` +
                `⚠️ Next SL on either side = FULL EXIT.`
            );
        }
    }
};


// ==========================================
// 📡 4. ROLL SCANNER (RADAR)
// ==========================================
export const scanForRoll = async (trade, liveSpotPrice) => {
    try {
        const io = getIO();
        if (!io || !liveSpotPrice) return;

        const isNifty = trade.index === 'NIFTY';
        const spreadDistance = getSpreadDistance(trade.index);

        let suggestedRoll = null;
        const baseSymbolInfoCall = extractBaseSymbol(trade.symbols.callSell);
        const baseSymbolInfoPut  = extractBaseSymbol(trade.symbols.putSell);

        // 🦋 MODE 1: DEFENSE — Iron Butterfly conversion
        // Roll the healthy side to the ATM short strike of the breached side
        if (trade.alertsSent.callDefense || trade.alertsSent.putDefense) {
            const sideToRoll       = trade.alertsSent.callDefense ? 'PE' : 'CE';
            const targetShortStrike = trade.alertsSent.callDefense
                ? baseSymbolInfoCall.strike
                : baseSymbolInfoPut.strike;
            const targetLongStrike  = sideToRoll === 'PE'
                ? targetShortStrike - spreadDistance
                : targetShortStrike + spreadDistance;

            const base       = baseSymbolInfoCall.base;
            const sellKite   = `${base}${targetShortStrike}${sideToRoll}`;
            const buyKite    = `${base}${targetLongStrike}${sideToRoll}`;
            const sellUpstox = kiteToUpstoxSymbol(sellKite, trade.index);
            const buyUpstox  = kiteToUpstoxSymbol(buyKite,  trade.index);

            const quotes = await getLTP([sellUpstox, buyUpstox]);
            let netPremium = 0;
            if (quotes) {
                const sellLTP = quotes[sellUpstox]?.last_price || 0;
                const buyLTP  = quotes[buyUpstox]?.last_price  || 0;
                netPremium = Math.abs(sellLTP - buyLTP);
            }

            suggestedRoll = {
                side: sideToRoll, type: 'DEFENSE',
                sellSymbol: sellKite, buySymbol: buyKite,
                netPremium: netPremium.toFixed(2),
                targetPremium: 'MAX CREDIT',
                isIronButterfly: true, status: 'READY'
            };
        }

        // 🦅 MODE 2: OFFENSE — Firefight inward roll (70% decay)
        // Scan up to 5 strikes inward looking for a net premium
        // within ±1 pt of the opposite spread's entry premium
        else if (trade.alertsSent.call70Decay || trade.alertsSent.put70Decay) {
            const sideToRoll          = trade.alertsSent.call70Decay ? 'CE' : 'PE';
            const targetPremium       = trade.alertsSent.call70Decay
                ? trade.putSpreadEntryPremium
                : trade.callSpreadEntryPremium;
            const currentShortStrike  = sideToRoll === 'CE'
                ? baseSymbolInfoCall.strike
                : baseSymbolInfoPut.strike;
            const oppositeShortStrike = sideToRoll === 'CE'
                ? baseSymbolInfoPut.strike
                : baseSymbolInfoCall.strike;
            const base     = baseSymbolInfoCall.base;
            const stepSize = isNifty ? 50 : 100;

            const strikesToScan = [];
            for (let i = 1; i <= 5; i++) {
                let scanShort = sideToRoll === 'CE'
                    ? currentShortStrike - (i * stepSize)
                    : currentShortStrike + (i * stepSize);
                let scanLong = sideToRoll === 'CE'
                    ? scanShort + spreadDistance
                    : scanShort - spreadDistance;

                if (sideToRoll === 'CE' && scanShort < oppositeShortStrike) break;
                if (sideToRoll === 'PE' && scanShort > oppositeShortStrike) break;

                strikesToScan.push({
                    sellKite:   `${base}${scanShort}${sideToRoll}`,
                    buyKite:    `${base}${scanLong}${sideToRoll}`,
                    sellUpstox: kiteToUpstoxSymbol(`${base}${scanShort}${sideToRoll}`, trade.index),
                    buyUpstox:  kiteToUpstoxSymbol(`${base}${scanLong}${sideToRoll}`,  trade.index),
                });
            }

            if (strikesToScan.length > 0) {
                const allSymbols = strikesToScan.flatMap(s => [s.sellUpstox, s.buyUpstox]);
                const quotes     = await getLTP(allSymbols);

                if (quotes) {
                    for (const pair of strikesToScan) {
                        const sellLTP    = quotes[pair.sellUpstox]?.last_price || 0;
                        const buyLTP     = quotes[pair.buyUpstox]?.last_price  || 0;
                        const netPremium = Math.abs(sellLTP - buyLTP);

                        if (netPremium >= targetPremium && netPremium <= targetPremium + 1.0) {
                            suggestedRoll = {
                                side: sideToRoll, type: 'OFFENSE',
                                sellSymbol: pair.sellKite, buySymbol: pair.buyKite,
                                netPremium: netPremium.toFixed(2),
                                targetPremium: targetPremium.toFixed(2),
                                isIronButterfly: false, status: 'READY'
                            };
                            break;
                        }
                    }
                }
            }
        }

        if (suggestedRoll) io.emit('roll_suggestion', suggestedRoll);

    } catch (err) {
        emitLog(`❌ Roll Radar Error: ${err.message}`, "error");
    }
};


// ==========================================
// 🔄 5. KITE POSITION SYNC MANAGER
//
// CIRCLE / RESET AWARENESS
// ────────────────────────
// After a RESET (one spread SL hit), the COMPLETED trade has spreadSLCount = 1.
// When Kite detects new positions, scanAndSyncOrders calls fetchHistoricalBuffer
// which walks MongoDB and correctly identifies which circle we are in and
// what buffer exists from this cycle's prior profits.
//
// Full exit (spreadSLCount = 2 or Iron Butterfly SL) → circle is over.
// The next new positions start Circle N+1 with a fresh buffer scan.
// ==========================================
export const scanAndSyncOrders = async () => {
    const index = getActiveIndexForToday();
    if (!index) return;

    const kc = getKiteInstance();
    try {
        const positions  = await kc.getPositions();
        let activeTrade  = await ActiveTrade().findOne({ index, status: 'ACTIVE' });

        const activeIndexPositions = positions.net.filter(
            p => p.tradingsymbol.startsWith(index) && p.quantity !== 0
        );

        // --- 🏁 TRADE COMPLETION (all positions closed) ---
        if (activeIndexPositions.length === 0 && activeTrade) {
            emitLog(`🏁 All positions closed. Finalizing trade...`, "info");
            const totalPnL = positions.net
                .filter(p => p.tradingsymbol.startsWith(index))
                .reduce((sum, p) => sum + p.pnl, 0);

            try {
                await TradePerformance().create({
                    strategy:      'IRON_CONDOR',
                    index,
                    activeTradeId: activeTrade._id,
                    exitReason:    totalPnL >= 0 ? 'PROFIT_TARGET' : 'STOP_LOSS_HIT',
                    realizedPnL:   totalPnL,
                    // firefightBookedPnL should be set separately during a firefight roll exit
                    notes: `Strategy: Iron Condor/Butterfly | Final P&L: ₹${totalPnL.toFixed(2)}`
                });
            } catch (dbErr) {
                emitLog(`❌ History Archive Error: ${dbErr.message}`, "error");
            }

            activeTrade.status   = 'COMPLETED';
            activeTrade.exitTime = new Date();
            await activeTrade.save();

            sendCondorAlert(
                `🏁 <b>Trade Completed: ${index}</b>\n` +
                `Total P&L: <b>₹${totalPnL.toLocaleString('en-IN')}</b>`
            );
            return;
        }

        if (activeIndexPositions.length === 0) return;

        // --- Detect leg structure from Kite positions ---
        let ceSell, ceBuy, peSell, peBuy;
        activeIndexPositions.forEach(p => {
            const isCall = p.tradingsymbol.endsWith('CE');
            const isSell = p.quantity < 0;
            if (isCall  && isSell)  ceSell = p;
            if (isCall  && !isSell) ceBuy  = p;
            if (!isCall && isSell)  peSell = p;
            if (!isCall && !isSell) peBuy  = p;
        });

        let isButterflyNow = false;
        if (ceSell && peSell) {
            const callStrike = extractBaseSymbol(ceSell.tradingsymbol)?.strike;
            const putStrike  = extractBaseSymbol(peSell.tradingsymbol)?.strike;
            if (callStrike === putStrike) isButterflyNow = true;
        }

        const tradeType = (ceSell && peSell) ? 'IRON_CONDOR' : ceSell ? 'CALL_SPREAD' : 'PUT_SPREAD';
        const callNet   = ceSell && ceBuy ? Math.abs(ceSell.average_price - ceBuy.average_price) : 0;
        const putNet    = peSell && peBuy ? Math.abs(peSell.average_price - peBuy.average_price) : 0;
        const lotSize   = Math.abs(ceSell?.quantity || peSell?.quantity || 65);
        const spotToken = 256265;

        // ── NEW TRADE CREATION ──
        // Fires when no ACTIVE trade exists and positions are detected.
        // Fetches historical buffer from MongoDB (circle-aware).
        const lastTrade    = await ActiveTrade().findOne({ index }).sort({ createdAt: -1 });
        const shouldCreateNew = !activeTrade && activeIndexPositions.length > 0 &&
            (!lastTrade || lastTrade.status === 'COMPLETED');

        if (shouldCreateNew) {
            emitLog(`🆕 New positions detected for ${index}. Creating new ActiveTrade...`, "info");

            const { bufferPoints: historicalBuffer, circleNumber } =
                await fetchHistoricalBuffer(index, lotSize);

            // Today's intraday closed PnL (rolls, partial exits today)
            const todayClosedPnL = positions.net
                .filter(p =>
                    p.tradingsymbol.startsWith(index) &&
                    p.quantity === 0 &&
                    (p.day_buy_quantity > 0 || p.day_sell_quantity > 0)
                )
                .reduce((sum, p) => sum + (p.realised || p.pnl || 0), 0);
            const todayBuffer = Math.max(0, todayClosedPnL / lotSize);

            const totalBuffer = historicalBuffer + todayBuffer;

            emitLog(
                `📊 Buffer breakdown [Circle #${circleNumber}]: ` +
                `Historical=${historicalBuffer.toFixed(2)} + Today=${todayBuffer.toFixed(2)} = Total=${totalBuffer.toFixed(2)}`,
                "info"
            );

            const newTrade = await ActiveTrade().create({
                index,
                status:          'ACTIVE',
                tradeType,
                isIronButterfly: isButterflyNow,
                bufferPremium:   totalBuffer,
                spreadSLCount:   0,           // tracks how many spread SLs hit this circle
                circleNumber,
                lotSize,
                callSpreadEntryPremium: callNet,
                putSpreadEntryPremium:  putNet,
                totalEntryPremium:      callNet + putNet,
                alertsSent: {
                    call70Decay:   false,
                    put70Decay:    false,
                    callDefense:   false,
                    putDefense:    false,
                    firefightAlert: false,
                    gapAlert:      false,
                },
                symbols: {
                    callSell: ceSell?.tradingsymbol || null,
                    callBuy:  ceBuy?.tradingsymbol  || null,
                    putSell:  peSell?.tradingsymbol || null,
                    putBuy:   peBuy?.tradingsymbol  || null,
                },
                tokens: { spotIndex: spotToken }
            });

            emitLog(`✅ New ActiveTrade created: ${newTrade._id} [Circle #${circleNumber}]`, "info");
            sendCondorAlert(
                `🆕 <b>New Iron Condor Detected: ${index} [Circle #${circleNumber}]</b>\n` +
                `Type: ${tradeType}\n` +
                `Call Spread Entry: ₹${callNet.toFixed(2)}\n` +
                `Put Spread Entry:  ₹${putNet.toFixed(2)}\n` +
                `Total IC Premium:  ₹${(callNet + putNet).toFixed(2)}\n` +
                `Buffer (history + today): ${totalBuffer.toFixed(2)} pts\n` +
                `Butterfly: ${isButterflyNow ? 'YES 🦋' : 'NO'}`
            );
            return;
        }

        // --- UPDATE EXISTING ACTIVE TRADE ---
        if (activeTrade) {
            const needsUpdate =
                activeTrade.symbols.callSell !== (ceSell?.tradingsymbol || null) ||
                activeTrade.isIronButterfly  !== isButterflyNow;

            if (needsUpdate) {
                const todayClosedPnL = positions.net
                    .filter(p =>
                        p.tradingsymbol.startsWith(index) &&
                        p.quantity === 0 &&
                        (p.day_buy_quantity > 0 || p.day_sell_quantity > 0)
                    )
                    .reduce((sum, p) => sum + (p.realised || p.pnl || 0), 0);

                // Only intraday booked profit added here — historical already baked in at creation
                activeTrade.bufferPremium          = Math.max(0, todayClosedPnL / lotSize);
                activeTrade.tradeType              = tradeType;
                activeTrade.isIronButterfly        = isButterflyNow;
                activeTrade.callSpreadEntryPremium = callNet || activeTrade.callSpreadEntryPremium;
                activeTrade.putSpreadEntryPremium  = putNet  || activeTrade.putSpreadEntryPremium;
                activeTrade.totalEntryPremium      =
                    activeTrade.callSpreadEntryPremium + activeTrade.putSpreadEntryPremium;
                activeTrade.symbols = {
                    callSell: ceSell?.tradingsymbol || null,
                    callBuy:  ceBuy?.tradingsymbol  || null,
                    putSell:  peSell?.tradingsymbol || null,
                    putBuy:   peBuy?.tradingsymbol  || null,
                };
                await activeTrade.save();

                sendCondorAlert(
                    `✅ <b>Bot Synced: ${index}</b>\n` +
                    `Butterfly Mode: <b>${isButterflyNow ? 'ON 🦋' : 'OFF'}</b>\n` +
                    `Intraday Buffer: <b>${activeTrade.bufferPremium.toFixed(2)} pts</b>`
                );
            }
        }

    } catch (err) {
        emitLog(`❌ Order Monitor Sync Error: ${err.message}`, "error");
    }
};