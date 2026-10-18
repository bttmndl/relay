import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createStore } from "../store.js";
import {
  originAllowed, allow, enqueue, pair, newRoom, attemptFlick, sweep, GRACE_MS, exportRoom, restoreRoom,
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
  const ok = attemptFlick(room, 0, { idx: 0, ang: 0.4, v: 6 });
  assert.equal(ok.ok, true);
  assert.ok(ok.snap.frame > before);
  assert.equal(ok.snap.pucks.length, 17);
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
  assert.equal(again.leaderboard(2)[0].id, "aaa");
  const restored = restoreRoom(again.loadRooms()[0]);
  assert.equal(restored.code, "ABC123");
  assert.equal(restored.players[0].resumeToken, "t0");
  assert.equal(restored.game.pucks.length, 17);
  fs.unlinkSync(file);
});
