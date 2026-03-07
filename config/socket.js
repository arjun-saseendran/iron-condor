import { Server } from "socket.io";

let io;

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: ["https://mariaalgo.online", "http://localhost:3000", "http://localhost:5173"],
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`🔌 UI connected: ${socket.id}`);
    socket.on("disconnect", () =>
      console.log(`🔌 UI disconnected: ${socket.id}`)
    );
  });

  return io;
};

// ✅ FIX: server.js creates its own `io = new Server(server, ...)` and never calls
// initSocket(), so the `io` variable here was never set — getIO() always returned null.
// All engines (ironCondorEngine, autoCondorEngine, upstoxLiveData) import getIO()
// and got null, meaning no events were ever emitted to the dashboard.
// setIO() lets server.js register its instance into this shared module.
export const setIO = (ioInstance) => {
  io = ioInstance;
};

export const getIO = () => io || null;