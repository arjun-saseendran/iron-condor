import mongoose from "mongoose";

// Single connection — both strategies share the same database
// Trades are distinguished by the `strategy` field on each document.
let _db = null;

export const connectDatabases = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error("❌ DB Error: MONGO_URI missing in .env");
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    _db = mongoose.connection;
    console.log(`✅ MongoDB Connected: ${_db.name}`);
  } catch (err) {
    console.error("❌ DB Connection Error:", err.message);
    process.exit(1);
  }

  mongoose.connection.on("disconnected", () =>
    console.warn("⚠️  MongoDB disconnected!")
  );
  mongoose.connection.on("error", (err) =>
    console.error("❌ MongoDB error:", err.message)
  );
};

// Legacy compatibility — both now return the same primary connection
export const getCondorDB  = () => mongoose.connection;
export const getTrafficDB = () => mongoose.connection;
