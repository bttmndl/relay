import {
  ONLINE_BOARD, createGame, launch, stepGame, serialize, applySync,
} from "../client/src/engine.js";

export const GRACE_MS = 45_000;
export const MAX_V = ONLINE_BOARD * 0.036;

const DEFAULT_ORIGINS = [
  "https://relaypuck.com",
  "https://www.relaypuck.com",
  "https://relay-tau-ten.vercel.app",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function originAllowed(origin, extra = "") {
  if (!origin) return true;
  const allowed = new Set([
    ...DEFAULT_ORIGINS,
    ...String(extra).split(",").map((s) => s.trim()).filter(Boolean),
  ]);
  if (allowed.has(origin)) return true;
  return /^https:\/\/relay-[a-z0-9-]+\.vercel\.app$/i.test(origin);
}

export function corsOrigin(extra) {
  return function check(origin, callback) {
    if (originAllowed(origin, extra)) callback(null, true);
    else callback(null, false);
  };
}

export function allow(bucket, key, limit, windowMs, now) {
  const prev = bucket.get(key) || [];
  const fresh = prev.filter((t) => now - t < windowMs);
  if (fresh.length >= limit) {
    bucket.set(key, fresh);
    return false;
  }
  fresh.push(now);
  bucket.set(key, fresh);
  return true;
}

export function enqueue(queue, entry) {
  const next = queue.filter((item) => item.playerId !== entry.playerId && item.socketId !== entry.socketId);
  next.push(entry);
  return next;
}

export function pair(queue, now) {
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i];
      const b = queue[j];
      const waited = Math.min(now - a.joinedAt, now - b.joinedAt);
      const window = 80 + Math.floor(waited / 3000) * 60;
      const ratingOk = Math.abs(a.rating - b.rating) <= window || waited >= 12000;
      const regionOk = a.region === b.region || waited >= 8000;
      if (ratingOk && regionOk) return [a, b];
    }
  }
  return null;
}

export function newRoom(code, clockStartsAt) {
  return {
    code,
    started: false,
    recorded: false,
    clockStartsAt: clockStartsAt ?? Date.now(),
    lastTickEmit: 0,
    notifiedWait: false,
    game: createGame(ONLINE_BOARD),
    players: [],
    rematchVotes: new Set(),
  };
}

export function restoreRoom(saved) {
  const room = newRoom(saved.code, saved.clockStartsAt || Date.now());
  room.started = !!saved.started;
  room.recorded = !!saved.recorded;
  applySync(room.game, saved.snap);
  room.players = (saved.players || []).map((p) => ({
    playerId: p.playerId,
    name: p.name,
    rating: p.rating ?? 1000,
    region: p.region || "unknown",
    resumeToken: p.resumeToken,
    socketId: null,
    disconnectedAt: Date.now(),
  }));
  return room;
}

export function exportRoom(room) {
  return {
    code: room.code,
    started: room.started,
    recorded: room.recorded,
    clockStartsAt: room.clockStartsAt,
    snap: serialize(room.game),
    players: room.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      rating: p.rating,
      region: p.region,
      resumeToken: p.resumeToken,
      disconnectedAt: p.disconnectedAt,
    })),
  };
}

export function attemptFlick(room, playerIndex, payload) {
  const g = room.game;
  if (!room.started || g.winner !== null) return { ok: false, reason: "Match is over" };
  if (g.phase !== "aim") return { ok: false, reason: "Pucks are still moving" };
  if (g.turn !== playerIndex) return { ok: false, reason: "Not your turn" };
  const idx = Number(payload?.idx);
  const ang = Number(payload?.ang);
  const v = Number(payload?.v);
  if (!Number.isInteger(idx) || !Number.isFinite(ang) || !Number.isFinite(v)) {
    return { ok: false, reason: "Bad flick" };
  }
  if (v <= 0 || v > MAX_V * 1.05) return { ok: false, reason: "Illegal power" };
  const puck = g.pucks[idx];
  if (!puck || !puck.alive) return { ok: false, reason: "That puck is gone" };
  const ev = [];
  if (!launch(g, idx, ang, v, ev)) return { ok: false, reason: "Flick rejected" };
  let guard = 0;
  while (g.phase === "resolve" && guard < 900) {
    stepGame(g, ev);
    guard++;
  }
  return { ok: true, snap: serialize(g) };
}

export function advanceAim(room, frames) {
  const g = room.game;
  if (!room.started || g.phase !== "aim" || g.winner !== null) {
    return { event: false, snap: serialize(g) };
  }
  const turn = g.turn;
  const port = g.livePort;
  const winner = g.winner;
  for (let i = 0; i < frames; i++) stepGame(g, []);
  const event = g.turn !== turn || g.livePort !== port || g.winner !== winner;
  return { event, snap: serialize(g) };
}

// Pure pass over rooms. Mutates disconnect bookkeeping flags only.
export function sweep(rooms, now, { graceMs = GRACE_MS, frames = 15 } = {}) {
  const actions = [];
  for (const room of rooms.values()) {
    if (!room.started || room.game.winner != null) continue;
    const connected = [];
    const expired = [];
    room.players.forEach((p, index) => {
      if (p.socketId && !p.disconnectedAt) connected.push(index);
      else if (p.disconnectedAt && now - p.disconnectedAt >= graceMs) expired.push(index);
    });
    if (expired.length === 1 && connected.length === 1) {
      actions.push({ type: "forfeit", code: room.code, winnerIndex: connected[0] });
      continue;
    }
    if (expired.length >= 2 || (expired.length === room.players.length && room.players.length > 0)) {
      actions.push({ type: "abandon", code: room.code });
      continue;
    }
    const waiting = room.players.some((p) => p.disconnectedAt && now - p.disconnectedAt < graceMs);
    if (waiting && !room.notifiedWait) {
      room.notifiedWait = true;
      actions.push({ type: "waiting", code: room.code });
    }
    if (waiting || now < (room.clockStartsAt || 0)) continue;
    const adv = advanceAim(room, frames);
    if (adv.event) {
      actions.push({ type: "state", code: room.code, kind: "tick", snap: adv.snap });
    } else if (now - room.lastTickEmit >= 1000) {
      room.lastTickEmit = now;
      actions.push({ type: "state", code: room.code, kind: "tick", snap: adv.snap });
    }
  }
  return actions;
}

export function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
}
