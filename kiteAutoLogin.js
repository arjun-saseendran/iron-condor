import puppeteer from 'puppeteer';
import { getKiteInstance, setAccessToken } from './services/kiteService.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';

dotenv.config();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const generateTOTP = (base32Secret, digits = 6, period = 30) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const s = base32Secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = '';
    for (const c of s) {
        const idx = alphabet.indexOf(c);
        if (idx === -1) throw new Error(`Invalid base32 char: '${c}'`);
        bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    const key = Buffer.from(bytes);
    const counter = Math.floor(Date.now() / 1000 / period);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (
        ((hmac[offset]     & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) <<  8) |
         (hmac[offset + 3] & 0xff)
    ) % Math.pow(10, digits);
    return String(code).padStart(digits, '0');
};

const typeIntoReactInput = async (page, selector, value) => {
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Selector not found: ${sel}`);
        el.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, value);
    await sleep(200);
};

export const performZerodhaAutoLogin = async () => {
    console.log("🤖 Starting Zerodha Auto-Login...");

    const userId     = process.env.ZERODHA_USER_ID;
    const password   = process.env.ZERODHA_PASSWORD;
    const totpSecret = process.env.ZERODHA_TOTP_SECRET;
    const apiKey     = process.env.KITE_API_KEY;
    const apiSecret  = process.env.KITE_API_SECRET;

    if (!userId || !password || !totpSecret || !apiKey || !apiSecret) {
        console.error("❌ Missing credentials in .env");
        return;
    }

    let browser = null;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        console.log("🌐 Navigating to Kite login...");
        await page.goto("https://kite.zerodha.com/", { waitUntil: 'networkidle2', timeout: 30000 });

        await page.waitForSelector("input[id='userid']", { visible: true, timeout: 10000 });
        await typeIntoReactInput(page, "input[id='userid']", userId);
        await typeIntoReactInput(page, "input[id='password']", password);
        await page.evaluate(() => {
            const btn = document.querySelector("button[type='submit']")
                     || Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toLowerCase().includes('login'));
            btn?.click();
        });
        console.log("🔑 Credentials submitted.");

        await page.waitForSelector("input[id='password']", { hidden: true, timeout: 15000 });
        await sleep(1000);
        console.log("✅ TOTP screen loaded.");

        const otp = generateTOTP(totpSecret);
        console.log(`🔢 Entering TOTP: ${otp}`);

        const totpSelector = await page.evaluate(() => {
            const selectors = ["input[id='totp']", "input[autocomplete='one-time-code']", "input[maxlength='6']", "input[type='number']", "input[type='text']"];
            for (const sel of selectors) {
                if (document.querySelector(sel)) return sel;
            }
            return null;
        });

        if (!totpSelector) throw new Error("TOTP input not found.");

        await typeIntoReactInput(page, totpSelector, otp);
        await sleep(300);

        await page.evaluate(() => {
            const btn = document.querySelector("button[type='submit']")
                     || Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toLowerCase().includes('continue'));
            btn?.click();
        });
        console.log("🖱️  Continue clicked.");

        console.log("⏳ Waiting for login result...");
        const start = Date.now();
        while (Date.now() - start < 20000) {
            await sleep(500);
            const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
            if (bodyText.includes('Invalid TOTP') || bodyText.includes('Invalid App Code')) {
                throw new Error(`TOTP rejected. OTP: ${otp}`);
            }
            const totpGone = await page.evaluate((sel) => !document.querySelector(sel), totpSelector);
            if (totpGone) { console.log("✅ Logged in!"); break; }
        }

        console.log("🔗 Getting request token...");
        let requestToken = null;
        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url();
            if (url.includes('request_token=')) {
                try { requestToken = new URL(url).searchParams.get('request_token'); } catch {}
                console.log(`🎫 Token intercepted!`);
            }
            req.continue();
        });

        await page.goto(`https://kite.trade/connect/login?api_key=${apiKey}&v=3`, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        await sleep(1500);

        if (!requestToken) {
            try { requestToken = new URL(page.url()).searchParams.get('request_token'); } catch {}
        }

        if (!requestToken) throw new Error("request_token not found. Set Redirect URL in https://developers.kite.trade");

        console.log("⚙️  Generating access token...");
        const kc = getKiteInstance();
        const session = await kc.generateSession(requestToken, apiSecret);
        setAccessToken(session.access_token);
        console.log("🎉 Done! Access token saved. Ready for algo trading.");

    } catch (error) {
        console.error("\n❌ Auto-Login Failed:", error.message);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
};

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    performZerodhaAutoLogin().catch(() => process.exit(1));
}