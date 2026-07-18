// ==================================================================
// RELAY — deterministic game engine
// Pure logic, no rendering, no randomness, fixed timestep.
// Both online clients run this identically; the shooter's post-shot
// snapshot (serialize/applySync) corrects any float drift.
// ==================================================================

export const MATCH_SECONDS = 180;
export const COLORS = {
  volt: "#7CFF4A",
  amp: "#FFA02E",
  hot: "#F4FFF0",
};
export const PCOL = [COLORS.volt, COLORS.amp];
export const PNAME = ["VOLT", "AMP"];

// ---------------- hot ports ----------------
// pockets are indexed [TL, TR, BL, BR]. Only one is "live" (powered) at a
// time; it rotates clockwise on a fixed clock so it's identical on every client.
export const PORT_ROTATE_SECONDS = 20;
const PORT_ROTATE_FRAMES = PORT_ROTATE_SECONDS * 60;
const PORT_PATTERNS = [[0], [1], [3], [2]];

export function getLivePorts(g) {
  const stage = Math.floor(g.frame / PORT_ROTATE_FRAMES) % PORT_PATTERNS.length;
  return PORT_PATTERNS[stage];
}

export function portRotateInfo(g) {
  const into = g.frame % PORT_ROTATE_FRAMES;
  return { live: getLivePorts(g), framesToNext: PORT_ROTATE_FRAMES - into };
}

export function createGame(size) {
  const S = size;
  const R = S / 34;
  const pad = S * 0.06;
  const cx = S / 2, cy = S / 2;
  const pucks = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pucks.push(mkPuck(cx + Math.cos(a) * R * 2.15, cy + Math.sin(a) * R * 2.15));
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 10;
    pucks.push(mkPuck(cx + Math.cos(a) * R * 4.4, cy + Math.sin(a) * R * 4.4));
  }
  const po = pad + R * 1.15;
  return {
    S, R, pad, cx, cy, pucks,
    pockets: [
      { x: po, y: po }, { x: S - po, y: po },
      { x: po, y: S - po }, { x: S - po, y: S - po },
    ],
    pocketR: R * 2.05,
    phase: "aim", // aim | resolve | done
    turn: 0,
    scores: [0, 0],
    timeLeft: MATCH_SECONDS,
    timeUp: false,
    sudden: false,
    winner: null, // 0 | 1 | 'draw'
    strikerIdx: -1,
    potsThisShot: 0,
    poisonThisShot: false,
    deadPortThisShot: false,
    streak: 0,
    settleFrames: 0,
    resolveTime: 0,
    frame: 0,
  };
}

function mkPuck(x, y) {
  return { x, y, vx: 0, vy: 0, charge: null, striker: false, alive: true, sink: null };
}

export function launch(g, idx, ang, v, ev) {
  const pk = g.pucks[idx];
  if (!pk || !pk.alive || pk.sink || g.phase !== "aim") return false;
  pk.striker = true;
  pk.vx = Math.cos(ang) * v;
  pk.vy = Math.sin(ang) * v;
  g.strikerIdx = idx;
  g.potsThisShot = 0;
  g.poisonThisShot = false;
  g.deadPortThisShot = false;
  g.phase = "resolve";
  g.settleFrames = 0;
  g.resolveTime = 0;
  ev.push({ t: "flick" });
  return true;
}

// one fixed physics step (call at 60 Hz)
export function stepGame(g, ev) {
  g.frame++;
  // sink animations are game state (they end in `alive = false`)
  g.pucks.forEach((p) => {
    if (!p.sink) return;
    p.x += (p.sink.px - p.x) * 0.25;
    p.y += (p.sink.py - p.y) * 0.25;
    p.sink.s *= 0.85;
    if (p.sink.s < 0.06) { p.alive = false; p.sink = null; }
  });

  if (g.phase !== "resolve") return;

  const live = g.pucks.filter((p) => p.alive && !p.sink);
  // integrate + walls
  live.forEach((p) => {
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.985; p.vy *= 0.985;
    const lo = g.pad + g.R, hi = g.S - g.pad - g.R;
    if (p.x < lo) { p.x = lo; p.vx = -p.vx * 0.82; }
    if (p.x > hi) { p.x = hi; p.vx = -p.vx * 0.82; }
    if (p.y < lo) { p.y = lo; p.vy = -p.vy * 0.82; }
    if (p.y > hi) { p.y = hi; p.vy = -p.vy * 0.82; }
  });
  // collisions + charge transfer
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d < g.R * 2 && d > 0) {
        const nx = dx / d, ny = dy / d;
        const ov = (g.R * 2 - d) / 2;
        a.x -= nx * ov; a.y -= ny * ov;
        b.x += nx * ov; b.y += ny * ov;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const imp = -rel * 0.93;
          a.vx -= nx * imp; a.vy -= ny * imp;
          b.vx += nx * imp; b.vy += ny * imp;
          if (Math.abs(rel) > 1.1) ev.push({ t: "hit", v: Math.abs(rel) });
          const aHot = a.striker || a.charge !== null;
          const bHot = b.striker || b.charge !== null;
          if (aHot && !bHot && !b.striker) {
            b.charge = g.turn;
            ev.push({ t: "charge", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          } else if (bHot && !aHot && !a.striker) {
            a.charge = g.turn;
            ev.push({ t: "charge", x1: b.x, y1: b.y, x2: a.x, y2: a.y });
          }
        }
      }
    }
  // pocket capture
  const liveGates = getLivePorts(g);
  live.forEach((p) => {
    if (p.sink) return;
    for (let pi = 0; pi < g.pockets.length; pi++) {
      const pk = g.pockets[pi];
      if (Math.hypot(p.x - pk.x, p.y - pk.y) < g.pocketR * 0.72) {
        if (!liveGates.includes(pi)) {
          // dead port: rejected back to center, turn passes regardless of any pots this shot
          p.x = g.cx; p.y = g.cy;
          p.vx = 0; p.vy = 0;
          p.striker = false;
          p.charge = null;
          g.deadPortThisShot = true;
          ev.push({ t: "deadPort", x: pk.x, y: pk.y });
        } else if (p.striker) {
          p.sink = { px: pk.x, py: pk.y, s: 1 };
          g.poisonThisShot = true;
          const opp = 1 - g.turn;
          g.scores[opp]++;
          ev.push({ t: "poison", player: opp });
          if (g.sudden) endMatch(g, opp, ev);
        } else {
          p.sink = { px: pk.x, py: pk.y, s: 1 };
          const scorer = p.charge !== null ? p.charge : g.turn;
          g.potsThisShot++;
          g.scores[scorer]++;
          ev.push({ t: "pot", player: scorer });
          if (g.sudden) endMatch(g, scorer, ev);
        }
        break;
      }
    }
  });

  // settle check
  g.resolveTime++;
  const stillLive = g.pucks.filter((p) => p.alive && !p.sink);
  const maxV = stillLive.length
    ? Math.max(...stillLive.map((p) => Math.hypot(p.vx, p.vy)))
    : 0;
  const anySinking = g.pucks.some((p) => p.sink);
  if (maxV < 0.07 && !anySinking) g.settleFrames++;
  else g.settleFrames = 0;
  if (g.phase === "resolve" && (g.settleFrames > 20 || g.resolveTime > 700)) {
    finishShot(g, ev);
  }
}

function endMatch(g, winner, ev) {
  if (g.winner !== null) return;
  g.winner = winner;
  g.phase = "done";
  ev.push({ t: "end", winner });
}

function finishShot(g, ev) {
  g.pucks.forEach((p) => {
    if (!p.alive || p.sink) return;
    p.vx = 0; p.vy = 0;
    p.striker = false;
    p.charge = null;
  });
  const shooter = g.turn;
  if (g.winner !== null) {
    ev.push({ t: "shotDone", shooter });
    return;
  }

  const remaining = g.pucks.filter((p) => p.alive && !p.sink).length;
  if ((g.timeUp || remaining === 0) && !g.sudden) {
    if (g.scores[0] === g.scores[1] && remaining > 0) {
      g.sudden = true;
      ev.push({ t: "sudden" });
    } else if (g.scores[0] === g.scores[1]) {
      g.winner = "draw";
      g.phase = "done";
      ev.push({ t: "end", winner: "draw" });
      ev.push({ t: "shotDone", shooter });
      return;
    } else {
      endMatch(g, g.scores[0] > g.scores[1] ? 0 : 1, ev);
      ev.push({ t: "shotDone", shooter });
      return;
    }
  }

  const keepTurn = g.potsThisShot > 0 && !g.poisonThisShot && !g.deadPortThisShot;
  if (keepTurn) {
    g.streak++;
    if (g.streak >= 2) ev.push({ t: "streak", n: g.streak, player: g.turn });
  } else {
    g.streak = 0;
    g.turn = 1 - g.turn;
    ev.push({ t: "turn", turn: g.turn });
  }
  g.phase = "aim";
  ev.push({ t: "shotDone", shooter });
}

// ---------------- online sync ----------------
export function serialize(g) {
  return {
    pucks: g.pucks.map((p) => ({ x: p.x, y: p.y, alive: p.alive })),
    scores: [...g.scores],
    turn: g.turn,
    sudden: g.sudden,
    winner: g.winner,
    timeLeft: g.timeLeft,
    streak: g.streak,
    frame: g.frame,
  };
}

export function applySync(g, snap) {
  snap.pucks.forEach((sp, i) => {
    const p = g.pucks[i];
    if (!p) return;
    p.x = sp.x; p.y = sp.y;
    p.alive = sp.alive;
    p.vx = 0; p.vy = 0;
    p.striker = false; p.charge = null; p.sink = null;
  });
  g.scores = [...snap.scores];
  g.turn = snap.turn;
  g.sudden = snap.sudden;
  g.winner = snap.winner;
  g.timeLeft = Math.min(g.timeLeft, snap.timeLeft);
  g.streak = snap.streak;
  g.frame = snap.frame;
  g.phase = snap.winner !== null ? "done" : "aim";
}

// ---------------- AI (local play only) ----------------
export function aiChooseShot(g) {
  const live = g.pucks.map((p, i) => ({ ...p, i })).filter((p) => p.alive && !p.sink);
  if (!live.length) return null;
  const maxV = g.S * 0.036;
  const liveGates = getLivePorts(g);
  const hotPockets = g.pockets.filter((_, pi) => liveGates.includes(pi));
  let best = null;
  live.forEach((s) => {
    live.forEach((t) => {
      if (s.i === t.i) return;
      hotPockets.forEach((pk) => {
        const stx = t.x - s.x, sty = t.y - s.y;
        const std = Math.hypot(stx, sty);
        const tpx = pk.x - t.x, tpy = pk.y - t.y;
        const tpd = Math.hypot(tpx, tpy);
        const dot = (stx * tpx + sty * tpy) / (std * tpd || 1);
        if (dot > 0.72 && std > g.R * 2.2) {
          const score = dot * 2.2 - std / g.S - tpd / (g.S * 2);
          if (!best || score > best.score) best = { s, t, score, std, tpd };
        }
      });
    });
  });
  if (best) {
    const ang = Math.atan2(best.t.y - best.s.y, best.t.x - best.s.x) + (Math.random() - 0.5) * 0.07;
    const v = Math.min(maxV, Math.max(4, (best.std + best.tpd) / 46)) * (0.92 + Math.random() * 0.18);
    return { idx: best.s.i, ang, v };
  }
  const s = live.reduce((a, b) =>
    Math.hypot(a.x - g.cx, a.y - g.cy) > Math.hypot(b.x - g.cx, b.y - g.cy) ? a : b);
  const ang = Math.atan2(g.cy - s.y, g.cx - s.x) + (Math.random() - 0.5) * 0.25;
  return { idx: s.i, ang, v: maxV * 0.5 };
}
