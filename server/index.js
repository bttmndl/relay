import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { serialize } from "../client/src/engine.js";
import { createStore, publicAccount } from "./store.js";
import {
  GRACE_MS, corsOrigin, allow, enqueue, pair, newRoom, restoreRoom, exportRoom,
  attemptFlick, sweep, log,
} from "./logic.js";

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.CLIENT_ORIGIN || "";
const DATA_FILE = process.env.RELAY_DATA_FILE
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "store.json");

const store = createStore(DATA_FILE);
const rooms = new Map();
let queue = [];
const hits = new Map();

for (const saved of store.loadRooms()) {
  try {
    if (!saved?.code || !saved.snap) continue;
    rooms.set(saved.code, restoreRoom(saved));
  } catch (err) {
    log("error", "skip saved room", { code: saved?.code, err: err.message });
  }
}

const app = express();
const checkOrigin = corsOrigin(ORIGIN);
app.use(cors({ origin: checkOrigin }));
app.get("/", (_req, res) => {
  res.json({ ok: true, game: "relay", rooms: rooms.size, accounts: store.count() });
});
app.get("/health", (_req, res) => res.send("ok"));
app.get("/leaderboard", (req, res) => {
  if (!allow(hits, `http:${req.ip}`, 30, 60_000, Date.now())) {
    return res.status(429).json({ error: "Slow down" });
  }
  res.json({ leaders: store.leaderboard(20), recent: store.recent(8) });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: checkOrigin, methods: ["GET", "POST"] } });

function persistRooms() {
  store.saveRooms([...rooms.values()].map(exportRoom));
}

function accountOf(socket) {
  if (socket.data.account) return socket.data.account;
  const account = store.upsert({ playerId: crypto.randomUUID(), name: "", region: "unknown" });
  socket.data.account = account;
  return account;
}

function findBySocket(socketId) {
  for (const room of rooms.values()) {
    const index = room.players.findIndex((p) => p.socketId === socketId);
    if (index >= 0) return { room, index };
  }
  return null;
}

function findByPlayer(playerId) {
  for (const room of rooms.values()) {
    const index = room.players.findIndex((p) => p.playerId === playerId);
    if (index >= 0) return { room, index };
  }
  return null;
}

function findByToken(token) {
  if (!token) return null;
  for (const room of rooms.values()) {
    const index = room.players.findIndex((p) => p.resumeToken === token);
    if (index >= 0) return { room, index };
  }
  return null;
}

function dropFromQueue(socketId) {
  queue = queue.filter((item) => item.socketId !== socketId);
}

function sendProfile(socket) {
  if (!socket?.data?.account) return;
  const fresh = store.get(socket.data.account.id) || socket.data.account;
  socket.data.account = fresh;
  socket.emit("profile", publicAccount(fresh));
}

function inLiveMatch(playerId) {
  const found = findByPlayer(playerId);
  if (!found) return false;
  return found.room.started && found.room.game.winner == null;
}

function startMatch(code) {
  const room = rooms.get(code);
  if (!room || room.players.length !== 2) return;
  room.started = true;
  room.recorded = false;
  room.clockStartsAt = Date.now() + 1500;
  room.rematchVotes = new Set();
  room.players.forEach((p) => { p.resumeToken = crypto.randomBytes(18).toString("hex"); });
  const snap = serialize(room.game);
  room.players.forEach((p, idx) => {
    const opponent = room.players[1 - idx];
    if (!p.socketId) return;
    io.to(p.socketId).emit("startGame", {
      roomCode: code,
      playerIndex: idx,
      startAt: room.clockStartsAt,
      resumeToken: p.resumeToken,
      snapshot: snap,
      youName: p.name,
      opponentName: opponent?.name || "RIVAL",
      rating: p.rating,
    });
  });
  persistRooms();
  log("info", "match start", { code, players: room.players.map((p) => p.playerId) });
}

function finishMatch(room, winner) {
  if (!room || room.recorded) return null;
  room.game.winner = winner;
  room.game.phase = "done";
  room.recorded = true;
  const match = store.recordMatch({
    roomCode: room.code,
    winner,
    players: room.players.map((p, i) => ({
      playerId: p.playerId,
      name: p.name,
      region: p.region,
      score: room.game.scores[i],
    })),
  });
  room.players.forEach((p) => {
    const fresh = store.get(p.playerId);
    if (fresh) p.rating = fresh.rating;
    if (p.socketId) sendProfile(io.sockets.sockets.get(p.socketId));
  });
  log("info", "match saved", { code: room.code, winner, id: match.id });
  return match;
}

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const p of room.players) {
    const socket = p.socketId && io.sockets.sockets.get(p.socketId);
    if (socket) socket.leave(code);
  }
  rooms.delete(code);
  persistRooms();
}

function limited(socket, key, limit, windowMs) {
  const ok = allow(hits, `${socket.id}:${key}`, limit, windowMs, Date.now());
  if (!ok) socket.emit("errorMsg", { message: "Slow down" });
  return ok;
}

function leave(socket, { forfeit = false } = {}) {
  dropFromQueue(socket.id);
  const found = findBySocket(socket.id);
  if (!found) return;
  const { room, index } = found;
  const player = room.players[index];
  player.socketId = null;
  socket.leave(room.code);
  if (!room.started || room.game.winner != null) {
    const other = room.players.find((p) => p !== player);
    if (other?.socketId) io.to(other.socketId).emit("errorMsg", { message: "Rival left the lobby" });
    closeRoom(room.code);
    return;
  }
  if (forfeit) {
    const winnerIndex = index === 0 ? 1 : 0;
    finishMatch(room, winnerIndex);
    const winner = room.players[winnerIndex];
    if (winner.socketId) {
      io.to(winner.socketId).emit("opponentLeft");
      io.to(winner.socketId).emit("state", { kind: "shot", snap: serialize(room.game) });
    }
    closeRoom(room.code);
    return;
  }
  player.disconnectedAt = Date.now();
  room.notifiedWait = false;
  persistRooms();
  log("info", "disconnect grace", { code: room.code, playerId: player.playerId, graceMs: GRACE_MS });
}

io.on("connection", (socket) => {
  log("info", "connect", { socket: socket.id });

  socket.on("hello", (body = {}) => {
    if (!limited(socket, "hello", 10, 30_000)) return;
    const account = store.upsert({
      playerId: String(body.playerId || accountOf(socket).id),
      name: body.name,
      region: body.region,
    });
    socket.data.account = account;
    sendProfile(socket);
  });

  socket.on("resume", ({ token } = {}) => {
    if (!limited(socket, "resume", 8, 30_000)) return;
    const found = findByToken(token);
    if (!found) return socket.emit("errorMsg", { message: "Match expired" });
    const { room, index } = found;
    const player = room.players[index];
    player.socketId = socket.id;
    player.disconnectedAt = null;
    room.notifiedWait = false;
    socket.join(room.code);
    const opponent = room.players[1 - index];
    socket.emit("resumed", {
      roomCode: room.code,
      playerIndex: index,
      startAt: Date.now(),
      resumed: true,
      resumeToken: player.resumeToken,
      snapshot: serialize(room.game),
      youName: player.name,
      opponentName: opponent?.name || "RIVAL",
      rating: player.rating,
    });
    if (opponent?.socketId) io.to(opponent.socketId).emit("opponentReconnected");
    persistRooms();
    log("info", "resume", { code: room.code, playerId: player.playerId });
  });

  socket.on("quickMatch", () => {
    if (!limited(socket, "queue", 8, 30_000)) return;
    const account = accountOf(socket);
    if (inLiveMatch(account.id)) return socket.emit("errorMsg", { message: "You are already in a match" });
    leave(socket, { forfeit: false });
    queue = enqueue(queue, {
      socketId: socket.id,
      playerId: account.id,
      name: account.name,
      rating: account.rating,
      region: account.region,
      joinedAt: Date.now(),
    });
    const matched = pair(queue, Date.now());
    if (!matched) return socket.emit("waiting");
    queue = queue.filter((item) => item !== matched[0] && item !== matched[1]);
    const code = makeCode();
    const room = newRoom(code, Date.now() + 1500);
    for (const item of matched) {
      const sock = io.sockets.sockets.get(item.socketId);
      room.players.push({
        playerId: item.playerId,
        name: item.name,
        rating: item.rating,
        region: item.region,
        resumeToken: null,
        socketId: item.socketId,
        disconnectedAt: null,
      });
      sock?.join(code);
      if (sock) sock.data.account = store.get(item.playerId);
    }
    rooms.set(code, room);
    startMatch(code);
  });

  socket.on("createRoom", () => {
    if (!limited(socket, "queue", 8, 30_000)) return;
    const account = accountOf(socket);
    if (inLiveMatch(account.id)) return socket.emit("errorMsg", { message: "You are already in a match" });
    leave(socket, { forfeit: false });
    const code = makeCode();
    const room = newRoom(code);
    room.players.push({
      playerId: account.id,
      name: account.name,
      rating: account.rating,
      region: account.region,
      resumeToken: null,
      socketId: socket.id,
      disconnectedAt: null,
    });
    rooms.set(code, room);
    socket.join(code);
    persistRooms();
    socket.emit("roomCreated", { roomCode: code });
  });

  socket.on("joinRoom", ({ roomCode } = {}) => {
    if (!limited(socket, "queue", 8, 30_000)) return;
    const code = String(roomCode || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || room.started) return socket.emit("errorMsg", { message: "Room not found" });
    if (room.players.length >= 2) return socket.emit("errorMsg", { message: "Room is full" });
    if (room.players.some((p) => p.socketId === socket.id)) return;
    const account = accountOf(socket);
    if (inLiveMatch(account.id)) return socket.emit("errorMsg", { message: "You are already in a match" });
    leave(socket, { forfeit: false });
    const target = rooms.get(code);
    if (!target) return socket.emit("errorMsg", { message: "Room not found" });
    target.players.push({
      playerId: account.id,
      name: account.name,
      rating: account.rating,
      region: account.region,
      resumeToken: null,
      socketId: socket.id,
      disconnectedAt: null,
    });
    socket.join(code);
    startMatch(code);
  });

  socket.on("cancelSearch", () => {
    leave(socket, { forfeit: false });
  });

  socket.on("flick", (payload) => {
    if (!limited(socket, "flick", 8, 2000)) return;
    const found = findBySocket(socket.id);
    if (!found || !found.room.started) return;
    const result = attemptFlick(found.room, found.index, payload);
    if (!result.ok) {
      log("warn", "flick rejected", { code: found.room.code, reason: result.reason });
      return socket.emit("state", { kind: "shot", snap: serialize(found.room.game), reason: result.reason });
    }
    const other = found.room.players[1 - found.index];
    if (other?.socketId) io.to(other.socketId).emit("opponentFlick", payload);
    io.to(found.room.code).emit("state", { kind: "shot", snap: result.snap });
    if (result.snap.winner != null) finishMatch(found.room, result.snap.winner);
    persistRooms();
  });

  socket.on("syncState", () => {
    const found = findBySocket(socket.id);
    if (!found) return;
    socket.emit("state", { kind: "shot", snap: serialize(found.room.game) });
  });

  socket.on("emote", (payload = {}) => {
    if (!limited(socket, "emote", 6, 10_000)) return;
    const found = findBySocket(socket.id);
    if (!found) return;
    const emote = String(payload.emote || "").slice(0, 4);
    if (!["👍", "🔥", "😂", "😭"].includes(emote)) return;
    const other = found.room.players.find((p) => p.socketId && p.socketId !== socket.id);
    if (other) io.to(other.socketId).emit("emote", { emote });
  });

  socket.on("rematch", () => {
    if (!limited(socket, "rematch", 4, 20_000)) return;
    const found = findBySocket(socket.id);
    if (!found || !found.room.started) return;
    const { room } = found;
    room.rematchVotes.add(socket.id);
    const other = room.players.find((p) => p.socketId && p.socketId !== socket.id);
    if (room.rematchVotes.size >= 2 && room.players.every((p) => p.socketId)) {
      room.game = newRoom(room.code).game;
      room.recorded = false;
      startMatch(room.code);
    } else if (other) {
      io.to(other.socketId).emit("rematchRequested");
    }
  });

  socket.on("leaveRoom", () => leave(socket, { forfeit: true }));
  socket.on("disconnect", () => {
    hits.delete(`${socket.id}:flick`);
    leave(socket, { forfeit: false });
    log("info", "disconnect", { socket: socket.id });
  });
});

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? makeCode() : code;
}

setInterval(() => {
  const actions = sweep(rooms, Date.now());
  for (const action of actions) {
    const room = rooms.get(action.code);
    if (!room) continue;
    if (action.type === "waiting") {
      for (const p of room.players) {
        if (p.socketId && !p.disconnectedAt) io.to(p.socketId).emit("opponentDisconnected", { graceMs: GRACE_MS });
      }
    } else if (action.type === "forfeit") {
      finishMatch(room, action.winnerIndex);
      const winner = room.players[action.winnerIndex];
      if (winner?.socketId) {
        io.to(winner.socketId).emit("opponentLeft");
        io.to(winner.socketId).emit("state", { kind: "shot", snap: serialize(room.game) });
      }
      log("info", "forfeit", { code: room.code, winner: winner?.playerId });
      closeRoom(room.code);
    } else if (action.type === "abandon") {
      log("info", "abandon", { code: room.code });
      closeRoom(room.code);
    } else if (action.type === "state") {
      io.to(room.code).emit("state", { kind: action.kind, snap: action.snap });
      if (action.snap?.winner != null) {
        finishMatch(room, action.snap.winner);
        persistRooms();
      }
    }
  }
}, 250).unref?.();

server.listen(PORT, () => {
  log("info", "listening", { port: PORT, rooms: rooms.size, accounts: store.count() });
});
