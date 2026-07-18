// ==================================================================
// RELAY — Socket.IO game server
// Thin relay architecture: clients run identical deterministic
// physics; the server matches players, relays flick inputs, and
// forwards the shooter's post-shot state sync (drift correction).
// ==================================================================

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.CLIENT_ORIGIN || "*";

const app = express();
app.use(cors({ origin: ORIGIN }));
app.get("/", (_req, res) => res.json({ ok: true, game: "relay", rooms: rooms.size }));
app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] },
});

// ---------------- state ----------------
/** roomCode -> { players: [socketId, socketId?], rematchVotes: Set, started: bool } */
const rooms = new Map();
let quickQueue = null; // socketId waiting for a quick match

const makeCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(c) ? makeCode() : c;
};

const roomOf = (socket) => {
  for (const [code, room] of rooms) {
    if (room.players.includes(socket.id)) return { code, room };
  }
  return null;
};

const startGame = (code) => {
  const room = rooms.get(code);
  if (!room || room.players.length !== 2) return;
  room.started = true;
  room.rematchVotes = new Set();
  const startAt = Date.now() + 1500; // small countdown buffer
  room.players.forEach((sid, idx) => {
    io.to(sid).emit("startGame", { roomCode: code, playerIndex: idx, startAt });
  });
};

const teardown = (socket, notify = true) => {
  if (quickQueue === socket.id) quickQueue = null;
  const found = roomOf(socket);
  if (!found) return;
  const { code, room } = found;
  const other = room.players.find((id) => id !== socket.id);
  rooms.delete(code);
  if (other && notify) io.to(other).emit("opponentLeft");
};

// ---------------- sockets ----------------
io.on("connection", (socket) => {
  // --- matchmaking ---
  socket.on("quickMatch", () => {
    teardown(socket, false);
    if (quickQueue && quickQueue !== socket.id && io.sockets.sockets.get(quickQueue)) {
      const code = makeCode();
      rooms.set(code, { players: [quickQueue, socket.id], rematchVotes: new Set(), started: false });
      quickQueue = null;
      startGame(code);
    } else {
      quickQueue = socket.id;
      socket.emit("waiting");
    }
  });

  socket.on("createRoom", () => {
    teardown(socket, false);
    const code = makeCode();
    rooms.set(code, { players: [socket.id], rematchVotes: new Set(), started: false });
    socket.emit("roomCreated", { roomCode: code });
  });

  socket.on("joinRoom", ({ roomCode }) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit("errorMsg", { message: "Room not found" });
    if (room.players.length >= 2) return socket.emit("errorMsg", { message: "Room is full" });
    if (room.players.includes(socket.id)) return;
    teardown(socket, false);
    // teardown may have deleted a room this socket hosted, re-check target still exists
    const target = rooms.get(code);
    if (!target) return socket.emit("errorMsg", { message: "Room not found" });
    target.players.push(socket.id);
    startGame(code);
  });

  socket.on("cancelSearch", () => {
    if (quickQueue === socket.id) quickQueue = null;
    teardown(socket, false);
  });

  // --- gameplay relay ---
  socket.on("flick", (payload) => {
    const found = roomOf(socket);
    if (!found || !found.room.started) return;
    const shooterIdx = found.room.players.indexOf(socket.id);
    const other = found.room.players.find((id) => id !== socket.id);
    if (other) io.to(other).emit("opponentFlick", { ...payload, shooterIdx });
  });

  // shooter's authoritative post-shot snapshot → forward to opponent
  socket.on("syncState", (payload) => {
    const found = roomOf(socket);
    if (!found || !found.room.started) return;
    const other = found.room.players.find((id) => id !== socket.id);
    if (other) io.to(other).emit("syncState", payload);
  });

  socket.on("emote", (payload) => {
    const found = roomOf(socket);
    if (!found) return;
    const other = found.room.players.find((id) => id !== socket.id);
    if (other) io.to(other).emit("emote", payload);
  });

  // --- rematch ---
  socket.on("rematch", () => {
    const found = roomOf(socket);
    if (!found) return;
    const { code, room } = found;
    room.rematchVotes.add(socket.id);
    const other = room.players.find((id) => id !== socket.id);
    if (room.rematchVotes.size >= 2) {
      startGame(code);
    } else if (other) {
      io.to(other).emit("rematchRequested");
    }
  });

  socket.on("leaveRoom", () => teardown(socket));
  socket.on("disconnect", () => teardown(socket));
});

server.listen(PORT, () => {
  console.log(`RELAY server listening on :${PORT}`);
});
