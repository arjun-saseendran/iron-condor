import { getKiteInstance, setAccessToken } from "../config/kiteConfig.js";

// ==========================================
// LOGIN — redirects to Zerodha OAuth page
// ==========================================
export const loginKite = (req, res) => {
  try {
    const loginUrl = getKiteInstance().getLoginURL();
    console.log("🔗 Redirecting to Zerodha login...");
    res.redirect(loginUrl);
  } catch (error) {
    console.error("❌ Kite Login URL error:", error.message);
    res.status(500).json({ error: "Could not generate login URL" });
  }
};

// ==========================================
// CALLBACK — receives request_token,
// generates access token, saves to disk
// ==========================================
export const kiteCallback = async (req, res) => {
  const requestToken = req.query.request_token;
  
  if (!requestToken) {
    return res.status(400).json({ error: "No request_token in callback URL" });
  }
  
  try {
    const response = await getKiteInstance().generateSession(
      requestToken,
      process.env.KITE_API_SECRET
    );
    
    // Save the new token to memory and disk
    await setAccessToken(response.access_token);
    
    console.log("✅ Kite session created.");
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