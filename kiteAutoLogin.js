import puppeteer from 'puppeteer';
import { getKiteInstance, setAccessToken } from './config/kiteConfig.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const generateTOTP = (base32Secret, digits = 6, period = 30) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const s = base32Secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = '';
    for (const c of s) {
        const idx = alphabet.indexOf(c);
        if (idx === -1) throw new Error("Invalid base32 char");
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
    const code = (((hmac[offset] & 0x7f) << 24) | ((hmac[offset+1] & 0xff) << 16) | ((hmac[offset+2] & 0xff) << 8) | (hmac[offset+3] & 0xff)) % Math.pow(10, digits);
    return String(code).padStart(digits, '0');
};

const typeIntoReactInput = async (page, selector, value) => {
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("Selector not found: " + sel);
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, value);
    await sleep(200);
};

/**
 * Writes or updates a key=value pair in the .env file.
 * If the key already exists, it replaces the line. Otherwise, it appends it.
 */
const saveTokenToEnv = (key, value) => {
    const envPath = path.resolve(process.cwd(), '.env');
    let content = '';

    if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8');
    }

    const lines = content.split('\n');
    const keyPattern = new RegExp(`^${key}=.*$`);
    const exists = lines.some(line => keyPattern.test(line));

    let updatedContent;
    if (exists) {
        // Replace the existing line
        updatedContent = lines.map(line => keyPattern.test(line) ? `${key}=${value}` : line).join('\n');
    } else {
        // Append new key at the end (ensure no double blank lines)
        updatedContent = content.trimEnd() + `\n${key}=${value}\n`;
    }

    fs.writeFileSync(envPath, updatedContent, 'utf8');
    console.log(`✅ ${key} saved to .env`);

    // Also update the live process.env so the current process can use it immediately
    process.env[key] = value;
};

export const performZerodhaAutoLogin = async () => {
    console.log("Starting Zerodha Auto-Login...");
    const userId = process.env.ZERODHA_USER_ID;
    const password = process.env.ZERODHA_PASSWORD;
    const totpSecret = process.env.ZERODHA_TOTP_SECRET;
    const apiKey = process.env.KITE_API_KEY;
    const apiSecret = process.env.KITE_API_SECRET;

    if (!userId || !password || !totpSecret || !apiKey || !apiSecret) {
        console.error("Missing credentials in .env");
        return;
    }

    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

        console.log("Navigating to Kite login...");
        await page.goto("https://kite.zerodha.com/", { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector("input[id='userid']", { visible: true, timeout: 10000 });
        await typeIntoReactInput(page, "input[id='userid']", userId);
        await typeIntoReactInput(page, "input[id='userid']", userId);
        await typeIntoReactInput(page, "input[id='password']", password);
        await page.evaluate(() => {
            const btn = document.querySelector("button[type='submit']") || Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toLowerCase().includes('login'));
            btn?.click();
        });
        console.log("Credentials submitted.");
        await page.waitForSelector("input[id='password']", { hidden: true, timeout: 15000 });
        await sleep(1000);
        console.log("TOTP screen loaded.");

        const otp = generateTOTP(totpSecret);
        console.log("Entering TOTP:", otp);
        const totpSelector = await page.evaluate(() => {
            for (const sel of ["input[id='totp']", "input[autocomplete='one-time-code']", "input[maxlength='6']", "input[type='number']", "input[type='text']"]) {
                if (document.querySelector(sel)) return sel;
            }
            return null;
        });
        if (!totpSelector) throw new Error("TOTP input not found.");
        await typeIntoReactInput(page, totpSelector, otp);
        await sleep(300);
        await page.evaluate(() => {
            const btn = document.querySelector("button[type='submit']") || Array.from(document.querySelectorAll('button')).find(b => b.innerText?.toLowerCase().includes('continue'));
            btn?.click();
        });
        console.log("Continue clicked.");

        console.log("Waiting for login result...");
        const start = Date.now();
        while (Date.now() - start < 20000) {
            await sleep(500);
            const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
            if (bodyText.includes('Invalid TOTP') || bodyText.includes('Invalid App Code')) throw new Error("TOTP rejected: " + otp);
            const totpGone = await page.evaluate((sel) => !document.querySelector(sel), totpSelector);
            if (totpGone) { console.log("Logged in!"); break; }
        }

        // Set interception BEFORE navigating so redirect is never missed even if instant
        console.log("Getting request token...");
        let requestToken = null;

        await page.setRequestInterception(true);

        const tokenPromise = new Promise((resolve) => {
            page.on('request', req => {
                const url = req.url();
                if (url.includes('request_token=')) {
                    try { requestToken = new URL(url).searchParams.get('request_token'); } catch {}
                    console.log("Token intercepted from redirect!");
                    req.abort();
                    resolve(requestToken);
                    return;
                }
                req.continue().catch(() => {});
            });
        });

        await page.goto(
            `https://kite.trade/connect/login?api_key=${apiKey}&v=3`,
            { waitUntil: 'domcontentloaded', timeout: 20000 }
        ).catch(() => {});


        // Wait for Authorize page to load then click the button
        await sleep(3000);
        const clicked = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button, a, input[type=submit]'))
                .find(el => el.innerText?.toLowerCase().includes('authoris') || el.innerText?.toLowerCase().includes('authoriz'));
            if (btn) { btn.click(); return true; }
            return false;
        });
        if (clicked) console.log("✅ Authorize button clicked.");
        else console.log("ℹ️  No Authorize button — redirect may have already fired.");

        // Wait for token interception OR timeout after 8 seconds
        await Promise.race([tokenPromise, sleep(8000)]);

        // Fallback: check current page URL
        if (!requestToken) {
            try { requestToken = new URL(page.url()).searchParams.get('request_token'); } catch {}
        }
        if (!requestToken) throw new Error("request_token not found. Verify KITE_REDIRECT_URL in Kite Developer Console.");

        console.log("⚙️  Generating access token...");
        const kc = getKiteInstance();
        const session = await kc.generateSession(requestToken, apiSecret);

        // Save access token to .env file (and update process.env live)
        saveTokenToEnv('KITE_ACCESS_TOKEN', session.access_token);

        // Also pass it to the kite service
        setAccessToken(session.access_token);

        console.log("🎉 Done! Kite access token saved to .env. Iron Condor orders ready.");

    } catch (error) {
        console.error("\n❌ Auto-Login Failed:", error.message);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
};

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    performZerodhaAutoLogin()
        .then(() => {
            console.log("👋 Login Process Finished.");
            process.exit(0);
        })
        .catch((err) => {
            console.error("Critical Failure:", err.message);
            process.exit(1);
        });
}