import puppeteer from 'puppeteer';
import { authenticator } from 'otplib';
import { getKiteInstance, setAccessToken } from './kiteService.js';
import dotenv from 'dotenv';

dotenv.config();

export const performZerodhaAutoLogin = async () => {
    console.log("🤖 Starting Zerodha Headless Login via Puppeteer...");
    
    const userId = process.env.ZERODHA_USER_ID;
    const password = process.env.ZERODHA_PASSWORD;
    const totpSecret = process.env.ZERODHA_TOTP_SECRET;
    const apiKey = process.env.KITE_API_KEY;
    const apiSecret = process.env.KITE_API_SECRET;

    if (!userId || !password || !totpSecret || !apiKey || !apiSecret) {
        console.error("❌ Missing Zerodha credentials in .env file. Cannot auto-login.");
        return;
    }

    let browser = null;

    try {
        // 1. Launch invisible browser (Puppeteer)
        // Note: --no-sandbox is required for running on Linux VPS environments like Hostinger
        browser = await puppeteer.launch({ 
            headless: true, // Change to false if you want to watch it log in on your local machine
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const page = await browser.newPage();

        // 2. Go to Kite Login
        console.log("🌐 Navigating to Kite login page...");
        await page.goto("https://kite.zerodha.com/", { waitUntil: 'networkidle2' });

        // 3. Enter User ID & Password
        console.log("🔑 Entering credentials...");
        await page.waitForSelector("input[type='text']", { visible: true });
        await page.type("input[type='text']", userId);
        await page.type("input[type='password']", password);
        await page.click("button[type='submit']");

        // 4. Handle TOTP (Time-based One Time Password)
        console.log("🔐 Generating and entering TOTP...");
        // Wait for the TOTP input field to appear
        await page.waitForSelector("input[type='text']", { visible: true, timeout: 10000 });
        
        // Generate the live 6-digit code using your secret
        const totpToken = authenticator.generate(totpSecret);
        await page.type("input[type='text']", totpToken);
        await page.click("button[type='submit']");

        // Wait for dashboard to load to confirm successful login
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        console.log("✅ Successfully logged into Kite Dashboard.");

        // 5. Authorize the API App to get Request Token
        console.log("🔗 Authorizing Kite Connect App...");
        const authUrl = `https://kite.trade/connect/login?api_key=${apiKey}&v=3`;
        await page.goto(authUrl, { waitUntil: 'networkidle2' });

        // 6. Extract Request Token from the Redirected URL
        const finalUrl = page.url();
        console.log(`📍 Redirected URL captured.`);
        
        const urlObj = new URL(finalUrl);
        const requestToken = urlObj.searchParams.get("request_token");

        if (!requestToken) {
            throw new Error("Could not find request_token in the redirected URL. Ensure your KITE_REDIRECT_URL is set correctly in the developer console.");
        }

        console.log(`🎫 Request Token Extracted! Generating Access Token...`);

        // 7. Generate Session and Save
        const kc = getKiteInstance();
        const session = await kc.generateSession(requestToken, apiSecret);
        
        setAccessToken(session.access_token);
        console.log("🎉 Auto-Login Complete! Token saved to disk.");

    } catch (error) {
        console.error("❌ Zerodha Auto-Login Failed:", error.message);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};