import axios from 'axios';

/**
 * Sends a formatted HTML message to Telegram.
 *
 * .env vars:
 *   TELEGRAM_BOT_TOKEN        — single bot used for all alerts
 *   TRAFFIC_TELEGRAM_CHAT_ID  — Traffic Light strategy channel (optional)
 *   CONDOR_TELEGRAM_CHAT_ID   — Iron Condor strategy channel (optional)
 *   TELEGRAM_CHAT_ID          — shared fallback for all strategies
 */
const sendAlert = async (message, chatId) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token || !chatId) {
        console.error("⚠️ Telegram Alert Failed: Missing BOT_TOKEN or CHAT_ID in .env");
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
        await axios.post(url, {
            chat_id:                chatId,
            text:                   message,
            parse_mode:             'HTML',
            disable_web_page_preview: true,
        });
        console.log("📤 Telegram notification sent.");
    } catch (error) {
        if (error.response) {
            console.error(`❌ Telegram API Error: ${error.response.data.description}`);
        } else {
            console.error(`❌ Telegram Network Error: ${error.message}`);
        }
    }
};

/**
 * 🚦 Traffic Light Strategy alerts
 * ✅ FIX: now uses TRAFFIC_TELEGRAM_CHAT_ID with fallback to TELEGRAM_CHAT_ID
 *         Previously hardcoded TELEGRAM_CHAT_ID — strategy-specific IDs were ignored
 */
export const sendTrafficAlert = async (message) => {
    const chatId = process.env.TRAFFIC_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    await sendAlert(message, chatId);
};

/**
 * 🦅 Iron Condor Strategy alerts
 * ✅ FIX: now uses CONDOR_TELEGRAM_CHAT_ID with fallback to TELEGRAM_CHAT_ID
 *         Previously hardcoded TELEGRAM_CHAT_ID — strategy-specific IDs were ignored
 */
export const sendCondorAlert = async (message) => {
    const chatId = process.env.CONDOR_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    await sendAlert(message, chatId);
};

/**
 * Generic alert — uses TELEGRAM_CHAT_ID (for server startup, system events etc.)
 */
export const sendTelegramAlert = async (message) => {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    await sendAlert(message, chatId);
};