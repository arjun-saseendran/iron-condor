import dotenv from 'dotenv';
dotenv.config();

export const sendTelegramAlert = async (message) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) {
        console.warn("⚠️ Telegram credentials missing in .env. Alert not sent:", message);
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML' // Allows us to use bold and italic text!
            })
        });
    } catch (error) {
        console.error("❌ Telegram Alert Failed:", error.message);
    }
};