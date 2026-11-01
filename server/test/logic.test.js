import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createStore } from "../store.js";
import { createGame, launch, stepGame, serialize, applySync, routeServerSnap, ONLINE_BOARD } from "../../client/src/engine.js";
import {
  originAllowed, allow, enqueue, pair, newRoom, attemptFlick, sweep, settledSnap, GRACE_MS, exportRoom, restoreRoom,
} from "../logic.js";

test("cors allows the game and rejects strangers", () => {
  assert.equal(originAllowed("https://relaypuck.com"), true);
  assert.equal(originAllowed("https://localhost"), true);
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed("https://relay-preview-abc.vercel.app"), true);
  assert.equal(originAllowed("https://evil.example"), false);
  assert.equal(originAllowed("https://extra.example", "https://extra.example"), true);
});

test("rate limit blocks the burst and allows a later call", () => {
  const bucket = new Map();
  const now = 1_000_000;
  assert.equal(allow(bucket, "flick", 2, 1000, now), true);
  assert.equal(allow(bucket, "flick", 2, 1000, now + 10), true);
  assert.equal(allow(bucket, "flick", 2, 1000, now + 20), false);
  assert.equal(allow(bucket, "flick", 2, 1000, now + 2000), true);
});

test("matchmaking prefers a close same-region rival, then widens", () => {
  const now = 5_000_000;
  let queue = [];
  queue = enqueue(queue, { socketId: "a", playerId: "a", rating: 1000, region: "Asia/Kolkata", joinedAt: now });
  queue = enqueue(queue, { socketId: "b", playerId: "b", rating: 1400, region: "Europe/London", joinedAt: now });
  queue = enqueue(queue, { socketId: "c", playerId: "c", rating: 1020, region: "Asia/Kolkata", joinedAt: now });
  const soon = pair(queue, now + 1000);
  assert.deepEqual(soon.map((p) => p.playerId).sort(), ["a", "c"]);
  const narrowed = queue.filter((p) => p.playerId !== "c");
  assert.equal(pair(narrowed, now + 1000), null);
  const later = pair(narrowed, now + 13000);
  assert.deepEqual(later.map((p) => p.playerId).sort(), ["a", "b"]);
});

test("server rejects an illegal flick and accepts a legal one", () => {
  const room = newRoom("ABCDEF");
  room.started = true;
  room.players = [{ playerId: "p0" }, { playerId: "p1" }];
  const wrongTurn = attemptFlick(room, 1, { idx: 0, ang: 0, v: 4 });
  assert.equal(wrongTurn.ok, false);
  const tooHard = attemptFlick(room, 0, { idx: 0, ang: 0.2, v: 999 });
  assert.equal(tooHard.ok, false);
  const before = room.game.frame;
  const clock = room.game.turnTimeLeft;
  const ok = attemptFlick(room, 0, { idx: 0, ang: 0.4, v: 6 });
  assert.equal(ok.ok, true);
  assert.equal(ok.shot, 1);
  assert.equal(room.game.phase, "resolve");
  assert.equal(room.game.turn, 0);
  assert.equal(room.game.frame, before);
  assert.equal(room.game.turnTimeLeft, clock);
  assert.ok(Math.hypot(room.game.pucks[0].vx, room.game.pucks[0].vy) > 1);
  assert.equal(settledSnap(room), null);
  assert.equal(attemptFlick(room, 1, { idx: 1, ang: 0.2, v: 4 }).reason, "Pucks are still moving");
});

test("reconnect grace keeps the room, then the rival is awarded the match", () => {
  const rooms = new Map();
  const room = newRoom("ROOM01");
  room.started = true;
  room.clockStartsAt = 0;
  room.players = [
    { playerId: "p0", socketId: "s0", disconnectedAt: null },
    { playerId: "p1", socketId: null, disconnectedAt: 10_000 },
  ];
  rooms.set(room.code, room);
  const waiting = sweep(rooms, 10_000 + 1000, { frames: 0 });
  assert.ok(waiting.some((a) => a.type === "waiting"));
  const gone = sweep(rooms, 10_000 + GRACE_MS, { frames: 0 });
  assert.deepEqual(gone.find((a) => a.type === "forfeit"), { type: "forfeit", code: "ROOM01", winnerIndex: 0 });
});

test("accounts, matches, and rooms survive a reload", () => {
  const file = path.join(os.tmpdir(), `relay-store-${Date.now()}.json`);
  const store = createStore(file);
  const a = store.upsert({ playerId: "aaa", name: "Volt!!", region: "Asia/Kolkata" });
  const b = store.upsert({ playerId: "bbb", name: "Amp", region: "Asia/Kolkata" });
  assert.equal(a.name, "Volt");
  store.recordMatch({
    roomCode: "ABC123",
    winner: 0,
    players: [
      { playerId: a.id, name: a.name, score: 8 },
      { playerId: b.id, name: b.name, score: 2 },
    ],
  });
  const room = newRoom("ABC123");
  room.started = true;
  room.players = [
    { playerId: a.id, name: a.name, rating: a.rating, region: a.region, resumeToken: "t0" },
    { playerId: b.id, name: b.name, rating: b.rating, region: b.region, resumeToken: "t1" },
  ];
  store.saveRooms([exportRoom(room)]);
  const again = createStore(file);
  assert.equal(again.get("aaa").wins, 1);
  assert.ok(again.get("aaa").rating > again.get("bbb").rating);
  assert.equal(again.leaderboard(2).length, 0);
  const member = again.register({
    email: "volt@relaypuck.com",
    passwordHash: "scrypt$salt$hash",
    name: "Volt",
    region: "Asia/Kolkata",
    guestId: "aaa",
  });
  assert.equal(member.wins, 1);
  assert.equal(again.get("aaa"), null);
  assert.equal(again.leaderboard(2)[0].id, member.id);
  const restored = restoreRoom(again.loadRooms()[0]);
  assert.equal(restored.code, "ABC123");
  assert.equal(restored.players[0].resumeToken, "t0");
  assert.equal(restored.game.pucks.length, 17);
  fs.unlinkSync(file);
});

function settle(g) {
  let n = 0;
  while (g.phase === "resolve" && n++ < 40) stepGame(g, []);
}

test("queen starts in the center and relocates only after she is moved", () => {
  const g = createGame(400);
  const queen = g.pucks.find((p) => p.isQueen);
  assert.equal(queen.x, g.cx);
  assert.equal(queen.y, g.cy);

  const other = g.pucks.find((p) => !p.isQueen);
  launch(g, g.pucks.indexOf(other), 0, 1, []);
  other.vx = 0;
  other.vy = 0;
  settle(g);
  assert.equal(queen.x, g.cx);
  assert.equal(queen.y, g.cy);

  const knockedX = g.cx + 37;
  const knockedY = g.cy - 19;
  launch(g, g.pucks.indexOf(queen), 0.2, 4, []);
  queen.vx = 0;
  queen.vy = 0;
  queen.x = knockedX;
  queen.y = knockedY;
  settle(g);
  const after = g.pucks.find((p) => p.isQueen && p.alive);
  assert.ok(after);
  assert.ok(Math.hypot(after.x - knockedX, after.y - knockedY) > 1);
  const others = g.pucks.filter((p) => p !== after && p.alive);
  assert.equal(others.some((p) => Math.hypot(p.x - after.x, p.y - after.y) < g.R * 2), false);
});

test("a missed shot clock passes the turn instead of stalling", () => {
  const g = createGame(400);
  const ev = [];
  for (let i = 0; i < 20 * 60 - 1; i++) stepGame(g, ev);
  assert.equal(g.turn, 0);
  assert.equal(g.phase, "aim");
  assert.equal(ev.some((e) => e.t === "turnTimeout"), false);
  stepGame(g, ev);
  assert.equal(g.turn, 1);
  assert.equal(g.phase, "aim");
  assert.equal(g.turnTimeLeft, 20 * 60);
  assert.equal(ev.filter((e) => e.t === "turnTimeout").length, 1);
  assert.equal(ev.find((e) => e.t === "shotDone")?.shooter, 0);
  const next = [];
  stepGame(g, next);
  assert.equal(g.turn, 1);
  assert.equal(next.length, 0);

  // an online client may display the countdown, but must not pass the turn itself
  const cosmetic = createGame(400);
  for (let i = 0; i < 20 * 60 + 30; i++) stepGame(cosmetic, [], { clock: false });
  assert.equal(cosmetic.turn, 0);
  assert.equal(cosmetic.phase, "aim");
  assert.equal(cosmetic.turnTimeLeft, 1);

  const rooms = new Map();
  const room = newRoom("CLOCK1");
  room.started = true;
  room.clockStartsAt = 0;
  room.players = [
    { playerId: "p0", socketId: "s0", disconnectedAt: null },
    { playerId: "p1", socketId: "s1", disconnectedAt: null },
  ];
  rooms.set(room.code, room);
  let saw = false;
  for (let i = 0; i < 80; i++) {
    const actions = sweep(rooms, 1_000_000 + i * 250, { frames: 15 });
    if (actions.some((a) => a.type === "state" && a.snap.turn === 1)) saw = true;
  }
  assert.equal(saw, true);
  assert.equal(room.game.turn, 1);
  assert.equal(room.game.phase, "aim");
  assert.equal(room.game.turnTimeLeft, 20 * 60);
});

test("online clients keep a shot in motion until it actually settles", () => {
  const local = { phase: "resolve", turn: 0, scores: [0, 0], awaitShot: 2 };
  assert.deepEqual(
    routeServerSnap(local, { kind: "tick", snap: { shot: 1, phase: "aim", turn: 0, scores: [0, 0], winner: null } }),
    { apply: false, queue: false, announceTimeout: false },
  );
  assert.deepEqual(
    routeServerSnap(local, { kind: "tick", snap: { shot: 2, phase: "resolve", turn: 0, scores: [0, 0], winner: null } }),
    { apply: false, queue: false, announceTimeout: false },
  );
  const queued = routeServerSnap(local, { kind: "shot", snap: { shot: 2, phase: "aim", turn: 1, scores: [1, 0], winner: null } });
  assert.equal(queued.queue, true);
  assert.equal(queued.apply, false);
  assert.equal(queued.announceTimeout, false);
  const rejected = routeServerSnap(local, { reason: "Not your turn", kind: "shot", snap: { shot: 1, phase: "aim", turn: 0, scores: [0, 0], winner: null } });
  assert.equal(rejected.apply, true);
  assert.equal(rejected.queue, false);
  const timeout = routeServerSnap(
    { phase: "aim", turn: 0, scores: [0, 0], awaitShot: 0 },
    { kind: "tick", snap: { shot: 0, phase: "aim", turn: 1, scores: [0, 0], winner: null } },
  );
  assert.equal(timeout.apply, true);
  assert.equal(timeout.announceTimeout, true);
  const whiff = routeServerSnap(
    { phase: "aim", turn: 0, scores: [0, 0], awaitShot: 2 },
    { kind: "tick", snap: { shot: 2, phase: "aim", turn: 1, scores: [0, 0], winner: null } },
  );
  assert.equal(whiff.apply, true);
  assert.equal(whiff.announceTimeout, false);
});

function sameBoard(a, b) {
  assert.equal(a.phase, b.phase);
  assert.equal(a.turn, b.turn);
  assert.equal(a.winner, b.winner);
  assert.deepEqual(a.scores, b.scores);
  assert.equal(a.shot, b.shot);
  assert.equal(a.livePort, b.livePort);
  a.pucks.forEach((p, i) => {
    const q = b.pucks[i];
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 1e-6, `puck ${i} drifted`);
    assert.equal(p.alive, q.alive);
    assert.equal(!!p.isQueen, !!q.isQueen);
  });
}

function playLockedShot(rooms, room, clients, flick, t0) {
  const shooter = room.game.turn;
  const start = room.game.pucks.map((p) => ({ x: p.x, y: p.y }));
  const clock = room.game.turnTimeLeft;
  assert.equal(attemptFlick(room, 1 - shooter, flick).ok, false);
  const ok = attemptFlick(room, shooter, flick);
  assert.equal(ok.ok, true);
  assert.equal(room.game.phase, "resolve");
  assert.equal(settledSnap(room), null);
  for (const c of clients) assert.equal(launch(c, flick.idx, flick.ang, flick.v, []), true);
  let moved = false;
  let emitted = 0;
  let result = null;
  for (let i = 0; i < 900 && room.game.phase === "resolve"; i++) {
    const actions = sweep(rooms, t0 + i, { frames: 1 });
    emitted += actions.length;
    result = actions.find((a) => a.kind === "shot") || result;
    for (const c of clients) stepGame(c, []);
    if (room.game.phase === "resolve") {
      assert.equal(actions.length, 0);
      assert.equal(room.game.turnTimeLeft, clock);
      if (room.game.pucks.some((p, n) => Math.hypot(p.x - start[n].x, p.y - start[n].y) > 1)) moved = true;
    }
  }
  assert.equal(room.game.phase, "aim");
  assert.ok(moved, "pucks never moved");
  assert.equal(emitted, 1);
  assert.equal(result?.kind, "shot");
  for (const c of clients) sameBoard(room.game, c);
  const resumed = createGame(ONLINE_BOARD);
  applySync(resumed, result.snap);
  sameBoard(room.game, resumed);
  assert.equal(settledSnap(room).shot, room.game.shot);
  return result;
}

test("a room flick plays out like a local shot, then the other player can go", () => {
  const rooms = new Map();
  const room = newRoom("PLAY01");
  room.started = true;
  room.clockStartsAt = 0;
  room.players = [
    { playerId: "p0", socketId: "s0", disconnectedAt: null },
    { playerId: "p1", socketId: "s1", disconnectedAt: null },
  ];
  rooms.set(room.code, room);
  const clientA = createGame(ONLINE_BOARD);
  const clientB = createGame(ONLINE_BOARD);
  applySync(clientA, serialize(room.game));
  applySync(clientB, serialize(room.game));

  const first = { idx: 3, ang: 0.35, v: ONLINE_BOARD * 0.03 };
  playLockedShot(rooms, room, [clientA, clientB], first, 10_000);
  const turnAfter = room.game.turn;
  const scoreAfter = room.game.scores.join(":");

  const second = { idx: 8, ang: -0.8, v: ONLINE_BOARD * 0.028 };
  playLockedShot(rooms, room, [clientA, clientB], second, 20_000);
  const progressed = room.game.turn !== turnAfter || room.game.scores.join(":") !== scoreAfter || room.game.shot === 2;
  assert.equal(progressed, true);
  assert.equal(room.game.shot, 2);
  assert.equal(room.game.phase, "aim");
  sameBoard(clientA, clientB);
});

test("a mid-shot snapshot can resume without skipping the motion", () => {
  const src = createGame(ONLINE_BOARD);
  assert.equal(launch(src, 4, 1.2, 7, []), true);
  for (let i = 0; i < 12; i++) stepGame(src, []);
  assert.equal(src.phase, "resolve");
  assert.ok(src.pucks.some((p) => Math.hypot(p.vx, p.vy) > 0.2));
  const copy = createGame(ONLINE_BOARD);
  applySync(copy, serialize(src));
  const evA = [];
  const evB = [];
  stepGame(src, evA);
  stepGame(copy, evB);
  sameBoard(src, copy);
  assert.equal(src.phase, "resolve");
});

