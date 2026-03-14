import { getKiteInstance, setAccessToken } from "../config/kiteConfig.js";
import { Token } from "../models/tokenModel.js";

export const login = (req, res) => {
  try {
    const loginUrl = getKiteInstance().getLoginURL();
    console.log("🔗 Redirecting to Zerodha login...");
    res.redirect(loginUrl);
  } catch (error) {
    console.error("❌ Kite Login URL error:", error.message);
    res.status(500).json({ error: "Could not generate login URL" });
  }
};

export const callback = async (req, res) => {
  const requestToken = req.query.request_token;

  if (!requestToken) {
    return res.status(400).json({ error: "No request_token in callback URL" });
  }

  try {
    const response = await getKiteInstance().generateSession(
      requestToken,
      process.env.KITE_API_SECRET
    );

    const accessToken = response.access_token;

    // Set token in memory
    await setAccessToken(accessToken);

    // Save token to DB
    await Token.findOneAndUpdate(
      {},
      { accessToken },
      { upsert: true, returnDocument: "after" }
    );

    console.log("✅ Kite session created and token saved to DB.");
    res.status(200).json({
      status: "success",
      message: "Kite authenticated! Iron Condor order service is now active.",
      user: response.user_name,
    });
  } catch (error) {
    console.error("❌ Kite Auth Error:", error.message);
    res.status(500).json({ error: "Kite authentication failed", details: error.message });
  }
};