import { fyers, setFyersAccessToken } from "../config/fyersConfig.js";
import { User } from "../models/userModel.js";
import { Token } from "../models/tokenModel.js";
// 🚨 CHANGED: Import the new Master Data Feed instead of individual sockets
import { initFyersLiveData } from "../services/fyersLiveData.js";

// ==========================================
// LOGIN — redirects to Fyers OAuth page
// ==========================================
export const loginFyers = (req, res) => {
  const url = fyers.generateAuthCode();
  res.redirect(url);
};

// ==========================================
// CALLBACK — receives auth_code from Fyers,
// generates access token, starts MASTER feed
// ==========================================
export const fyersCallback = async (req, res) => {
  try {
    const { auth_code } = req.query;
    if (!auth_code) {
      return res.status(400).send("❌ No auth code received from Fyers");
    }

    const response = await fyers.generate_access_token({
      client_id: process.env.FYERS_APP_ID,
      secret_key: process.env.FYERS_SECRET_ID,
      auth_code,
    });

    if (response.s !== "ok") {
      console.error("❌ Token generation failed:", response);
      return res.status(400).send("Token generation failed");
    }

    const accessToken = response.access_token;

    // Set token in SDK + env (shared by both strategies)
    setFyersAccessToken(accessToken);

    // 🚨 CHANGED: Start the unified Master Data Feed
    const io = req.app.get("io");
    await initFyersLiveData(io);

    // Save user + token to Traffic Light DB
    const profile = await fyers.get_profile();
    if (profile.s !== "ok" || !profile.data) {
      return res.status(400).send("Failed to fetch Fyers profile");
    }

    let user = await User.findOne({ email: profile.data.email_id });
    if (!user) {
      user = await User.create({
        name: profile.data.name,
        email: profile.data.email_id,
      });
    }

    await Token.findOneAndUpdate(
      { user: user._id },
      { accessToken },
      { upsert: true, returnDocument: "after" },
    );

    res.send(
      "<h1>✅ Fyers Connected!</h1><p>The Master Strategy feed is now live. You can close this tab.</p>",
    );
  } catch (error) {
    console.error("❌ Fyers Auth Error:", error);
    res.status(500).send("Something went wrong during Fyers authentication");
  }
};

// ==========================================
// PROFILE
// ==========================================
export const getProfile = async (req, res) => {
  try {
    const profile = await fyers.get_profile();
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// ==========================================
// QUOTES
// ==========================================
export const getQuotes = async (req, res) => {
  try {
    const symbols = req.query.symbols || "NSE:SBIN-EQ";
    const quotes = await fyers.getQuotes({ symbols });
    res.json(quotes);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch quotes" });
  }
};
