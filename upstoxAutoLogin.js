import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import puppeteer from "puppeteer";
import { setUpstoxAccessToken } from "./config/upstoxConfig.js";
import { fileURLToPath } from "url";
import "dotenv/config";

// ─── Validate ENV ─────────────────────────────────────────────────────────────
function validateEnv() {
    const required = [
        "UPSTOX_API_KEY",
        "UPSTOX_API_SECRET",
        "UPSTOX_REDIRECT_URI",
        "UPSTOX_MOBILE",
        "UPSTOX_PIN",
        "UPSTOX_TOTP_SECRET",
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(`❌ Missing required env vars: ${missing.join(", ")}`);
    }
}

// ─── Native TOTP (RFC 6238) ───────────────────────────────────────────────────
function base32Decode(base32) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = base32.replace(/[^A-Z2-7]/gi, "").toUpperCase();
    let bits = "";
    for (const char of clean) {
        const val = alphabet.indexOf(char);
        if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
        bits += val.toString(2).padStart(5, "0");
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function generateTotp(secret, digits = 6, period = 30) {
    const key = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / period);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return String(code % Math.pow(10, digits)).padStart(digits, "0");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helper: update .env file ─────────────────────────────────────────────────
function updateEnvFile(key, value) {
    const envPath = path.resolve(process.cwd(), ".env");
    let envData = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const regex = new RegExp(`^${key}=.*`, "m");
    const newLine = `${key}="${value}"`;
    envData = regex.test(envData)
        ? envData.replace(regex, newLine)
        : envData + (envData.endsWith("\n") ? "" : "\n") + newLine + "\n";
    fs.writeFileSync(envPath, envData, "utf8");
    process.env[key] = value;
    console.log(`💾 ${key} saved to .env`);
}

// ─── Helper: type into React inputs (same as kiteAutoLogin) ──────────────────
const typeIntoInput = async (page, selector, value) => {
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("Selector not found: " + sel);
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
        ).set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }, selector, value);
    await sleep(200);
};

// ─── Main Login Flow ──────────────────────────────────────────────────────────
export const performUpstoxAutoLogin = async () => {
    console.log("🤖 Starting Upstox Auto-Login...");
    validateEnv();

    const {
        UPSTOX_API_KEY,
        UPSTOX_API_SECRET,
        UPSTOX_REDIRECT_URI,
        UPSTOX_MOBILE,
        UPSTOX_PIN,
        UPSTOX_TOTP_SECRET,
    } = process.env;

    let browser = null;

    try {
        // ── Step 1: Open Upstox login page ──────────────────────────────────
        const loginUrl =
            `https://api.upstox.com/v2/login/authorization/dialog` +
            `?client_id=${UPSTOX_API_KEY}` +
            `&redirect_uri=${encodeURIComponent(UPSTOX_REDIRECT_URI)}` +
            `&response_type=code` +
            `&scope=orders`;

        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        );

        console.log("🌐 Navigating to Upstox login...");
        await page.goto(loginUrl, { waitUntil: "networkidle2", timeout: 30000 });

        // ── Step 2: Detect login page structure and enter mobile ────────────
        // Wait longer for JS-rendered page
        await sleep(5000);

        // Confirmed selector: input#mobileNum
        await typeIntoInput(page, "input#mobileNum", UPSTOX_MOBILE);

        // Find and click the OTP/continue button
        await page.evaluate(() => {
            const btn =
                document.querySelector("button#getOtp") ||
                document.querySelector("button[type='submit']") ||
                Array.from(document.querySelectorAll("button")).find(
                    b => b.innerText?.toLowerCase().includes("get otp") ||
                         b.innerText?.toLowerCase().includes("continue") ||
                         b.innerText?.toLowerCase().includes("send otp")
                );
            btn?.click();
        });
        console.log("📱 Mobile submitted. Waiting for OTP screen...");
        await sleep(3000);

        // ── Step 3: Enter TOTP ────────────────────────────────────────────────
        const totp = generateTotp(UPSTOX_TOTP_SECRET);
        console.log(`🔑 Generated TOTP: ${totp}`);

        // Upstox OTP is 6 individual digit boxes — fill them one by one
        const otpInputs = await page.$$("input.otp-input, input[maxlength='1']");
        if (otpInputs.length >= 6) {
            for (let i = 0; i < 6; i++) {
                await otpInputs[i].click();
                await otpInputs[i].type(totp[i]);
                await sleep(100);
            }
        } else {
            // Fallback: single OTP input field
            const otpSelector = await page.evaluate(() => {
                for (const sel of [
                    "input#otpNum",
                    "input[autocomplete='one-time-code']",
                    "input[maxlength='6']",
                    "input[type='number']",
                ]) {
                    if (document.querySelector(sel)) return sel;
                }
                return null;
            });
            if (!otpSelector) throw new Error("OTP input not found.");
            await typeIntoInput(page, otpSelector, totp);
        }

        // Click Continue / Verify
        await page.evaluate(() => {
            const btn =
                document.querySelector("button#continueBtn") ||
                Array.from(document.querySelectorAll("button")).find(
                    b => b.innerText?.toLowerCase().includes("continue") ||
                         b.innerText?.toLowerCase().includes("verify")
                );
            btn?.click();
        });
        console.log("✅ TOTP submitted.");
        await sleep(2000);

        // ── Step 4: Enter PIN ─────────────────────────────────────────────────
        const pinInputs = await page.$$("input.pin-input, input[maxlength='1'][type='password']");
        if (pinInputs.length >= 4) {
            for (let i = 0; i < Math.min(UPSTOX_PIN.length, pinInputs.length); i++) {
                await pinInputs[i].click();
                await pinInputs[i].type(UPSTOX_PIN[i]);
                await sleep(100);
            }
        } else {
            const pinSelector = await page.evaluate(() => {
                for (const sel of [
                    "input#pinCode",
                    "input[type='password']",
                    "input[maxlength='6']",
                ]) {
                    if (document.querySelector(sel)) return sel;
                }
                return null;
            });
            if (pinSelector) await typeIntoInput(page, pinSelector, UPSTOX_PIN);
        }

        await page.evaluate(() => {
            const btn =
                document.querySelector("button#pinContinueBtn") ||
                Array.from(document.querySelectorAll("button")).find(
                    b => b.innerText?.toLowerCase().includes("continue") ||
                         b.innerText?.toLowerCase().includes("login")
                );
            btn?.click();
        });
        console.log("🔐 PIN submitted.");
        await sleep(2000);

        // ── Step 5: Catch auth_code from navigation URL ──────────────────────
        // Use 'response' event instead of aborting requests — auth code is
        // single-use and aborting the redirect can cause race conditions with
        // the live server also trying to consume it.
        console.log("🔍 Waiting for auth_code redirect...");
        let authCode = null;

        const codePromise = new Promise((resolve) => {
            // Watch all navigations/responses for the redirect_uri with code=
            page.on("response", (response) => {
                const url = response.url();
                if (url.includes(UPSTOX_REDIRECT_URI) && url.includes("code=")) {
                    try { authCode = new URL(url).searchParams.get("code"); } catch {}
                    if (authCode) { console.log("🎯 Auth code from response URL!"); resolve(authCode); }
                }
            });
            // Also watch for navigation events
            page.on("framenavigated", (frame) => {
                if (frame !== page.mainFrame()) return;
                const url = frame.url();
                if (url.includes("code=")) {
                    try { authCode = new URL(url).searchParams.get("code"); } catch {}
                    if (authCode) { console.log("🎯 Auth code from navigation!"); resolve(authCode); }
                }
            });
        });

        await Promise.race([codePromise, sleep(15000)]);

        // Final fallback: check current page URL
        if (!authCode) {
            try { authCode = new URL(page.url()).searchParams.get("code"); } catch {}
        }
        if (!authCode) throw new Error("auth_code not found. Check UPSTOX_REDIRECT_URI matches Developer Console exactly.");

        console.log("✅ Auth code received.");

        console.log("✅ Auth code received.");

        // ── Step 6: Exchange auth_code for access_token ───────────────────────
        console.log("⚙️  Exchanging auth code for access token...");
        const tokenRes = await axios.post(
            "https://api.upstox.com/v2/login/authorization/token",
            new URLSearchParams({
                code:          authCode,
                client_id:     UPSTOX_API_KEY,
                client_secret: UPSTOX_API_SECRET,
                redirect_uri:  UPSTOX_REDIRECT_URI,
                grant_type:    "authorization_code",
            }),
            {
                headers: {
                    "Content-Type":  "application/x-www-form-urlencoded",
                    "Accept":        "application/json",
                    "Api-Version":   "2.0",
                }
            }
        );

        if (!tokenRes.data?.access_token) {
            throw new Error(`Token exchange failed: ${JSON.stringify(tokenRes.data)}`);
        }

        const accessToken = tokenRes.data.access_token;
        console.log("✅ Access token retrieved successfully!");

        // Save token directly to .env — no redirect needed
        updateEnvFile("UPSTOX_ACCESS_TOKEN", accessToken);
        setUpstoxAccessToken(accessToken);

        console.log("🎉 Done! Upstox access token saved to .env. Ready for orders.");
        return accessToken;

    } catch (error) {
        console.error("\n❌ Upstox Auto-Login Failed:", error.message);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
};

// ─── Run directly if called as script ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    performUpstoxAutoLogin()
        .then(() => {
            console.log("👋 Login Process Finished.");
            process.exit(0);
        })
        .catch((err) => {
            console.error("Critical Failure:", err.message);
            process.exit(1);
        });
}