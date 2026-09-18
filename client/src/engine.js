// ==================================================================
// RELAY — deterministic game engine
// Pure logic, no rendering, no randomness, fixed timestep.
// Both online clients run this identically; the shooter's post-shot
// snapshot (serialize/applySync) corrects any float drift.
// ==================================================================

export const COLORS = {
  volt: "#7CFF4A",
  amp: "#FFA02E",
  hot: "#F4FFF0",
};
export const PCOL = [COLORS.volt, COLORS.amp];
export const PNAME = ["VOLT", "AMP"];

// ---------------- the queen ----------------
// one special center puck (like carrom's red goti). Potting it alone banks
// no points — the shooter must then pot one of their own regular pucks in
// the same unbroken turn to "cover" it and claim the bonus. If the turn
// passes before that happens, the queen returns uncovered to the center.
export const QUEEN_BONUS = 2;

// ---------------- shot clock ----------------
// each player gets a fixed window to take their shot. It resets after
// every resolved shot (so a RELAY streak gets a fresh window each time,
// not just a change of turn) and runs out only while waiting to aim.
// Running out passes the turn with no score, like any other foul.
export const TURN_SECONDS = 20;
const TURN_FRAMES = TURN_SECONDS * 60;

// ---------------- hot ports ----------------
// pockets are indexed [TL, TR, BL, BR]. Only one is "live" (powered) at a
// time — but instead of a fixed rotation, it's whichever pocket is
// currently the HARDEST to pot into given the live puck layout. It stays
// live for as long as it holds that title. The moment another pocket
// overtakes it, a fixed warning window opens (PORT_SHIFT_WARNING_SECONDS);
// if the challenger is still hardest when that runs out, the port shifts
// to it. Purely a function of game state, so it stays identical on both
// clients without needing its own random or wall-clock input.
export const PORT_SHIFT_WARNING_SECONDS = 5;
const PORT_SHIFT_WARNING_FRAMES = PORT_SHIFT_WARNING_SECONDS * 60;

// how good is the best available shot at pocket `pi` right now? Mirrors the
// AI's own (source puck, target puck) alignment heuristic, but scoped to a
// single pocket and with a looser gate so every pocket gets a real number
// to compare rather than tying at zero. Higher = easier; the live pocket
// is whichever comes out LOWEST.
function pocketEase(g, pi) {
  const pk = g.pockets[pi];
  const live = g.pucks.filter((p) => p.alive && !p.sink);
  let best = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = 0; j < live.length; j++) {
      if (i === j) continue;
      const s = live[i], t = live[j];
      const stx = t.x - s.x, sty = t.y - s.y;
      const std = Math.hypot(stx, sty);
      if (std < g.R * 2.2) continue;
      const tpx = pk.x - t.x, tpy = pk.y - t.y;
      const tpd = Math.hypot(tpx, tpy);
      const dot = (stx * tpx + sty * tpy) / (std * tpd || 1);
      if (dot <= 0) continue;
      const ease = dot * 2.2 - std / g.S - tpd / (g.S * 2);
      if (ease > best) best = ease;
    }
  }
  return best;
}

function hardestPocket(g) {
  let idx = 0, min = Infinity;
  for (let pi = 0; pi < g.pockets.length; pi++) {
    const ease = pocketEase(g, pi);
    if (ease < min) { min = ease; idx = pi; }
  }
  return idx;
}

// re-evaluated every frame (cheap: pockets × pucks²) so it reacts as soon
// as a shot resettles the board, whether or not one is currently in flight
function updateLivePort(g) {
  const hardest = hardestPocket(g);
  if (hardest === g.livePort) {
    g.portShift = null;
    return;
  }
  if (!g.portShift || g.portShift.target !== hardest) {
    g.portShift = { target: hardest, framesLeft: PORT_SHIFT_WARNING_FRAMES };
  } else if (--g.portShift.framesLeft <= 0) {
    g.livePort = hardest;
    g.portShift = null;
  }
}

export function getLivePorts(g) {
  return [g.livePort];
}

export function portRotateInfo(g) {
  return {
    live: getLivePorts(g),
    pending: g.portShift ? { target: g.portShift.target, framesLeft: g.portShift.framesLeft } : null,
  };
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
  const queen = mkPuck(cx, cy);
  queen.isQueen = true;
  pucks.push(queen);
  const po = pad + R * 1.15;
  const g = {
    S, R, pad, cx, cy, pucks,
    pockets: [
      { x: po, y: po }, { x: S - po, y: po },
      { x: po, y: S - po }, { x: S - po, y: S - po },
    ],
    pocketR: R * 2.05,
    phase: "aim", // aim | resolve | done
    turn: 0,
    scores: [0, 0],
    winner: null, // 0 | 1 | 'draw'
    strikerIdx: -1,
    potsThisShot: 0,
    poisonThisShot: false,
    deadPortThisShot: false,
    queenPending: null, // player index who potted the queen, awaiting a cover
    streak: 0,
    settleFrames: 0,
    resolveTime: 0,
    frame: 0,
    livePort: 0,
    portShift: null,
    turnTimeLeft: TURN_FRAMES,
  };
  g.livePort = hardestPocket(g);
  return g;
}

function mkPuck(x, y) {
  return { x, y, vx: 0, vy: 0, charge: null, striker: false, alive: true, sink: null, isQueen: false };
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

  // re-rank pocket difficulty continuously — including between shots, so a
  // long think doesn't stall the warning countdown
  if (g.winner === null) updateLivePort(g);

  // shot clock only runs while waiting to aim — frozen mid-shot and once the match ends
  if (g.phase === "aim" && g.winner === null && --g.turnTimeLeft <= 0) {
    turnTimeoutPass(g, ev);
  }

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
        } else if (p.isQueen) {
          // queen potted: no score yet — must be covered before the turn ends
          p.sink = { px: pk.x, py: pk.y, s: 1 };
          g.potsThisShot++;
          g.queenPending = g.turn;
          ev.push({ t: "queenPot", player: g.turn });
        } else {
          p.sink = { px: pk.x, py: pk.y, s: 1 };
          const scorer = p.charge !== null ? p.charge : g.turn;
          g.potsThisShot++;
          g.scores[scorer]++;
          ev.push({ t: "pot", player: scorer });
          if (g.queenPending !== null) {
            g.scores[g.queenPending] += QUEEN_BONUS;
            ev.push({ t: "queenCover", player: g.queenPending });
            g.queenPending = null;
          }
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

// queen potted but not covered before the turn ends — it returns uncovered
function returnQueenIfPending(g, ev) {
  if (g.queenPending === null) return;
  const queen = g.pucks.find((p) => p.isQueen);
  if (queen) {
    queen.alive = true;
    queen.sink = null;
    queen.x = g.cx; queen.y = g.cy;
    queen.vx = 0; queen.vy = 0;
    queen.striker = false;
    queen.charge = null;
  }
  g.queenPending = null;
  ev.push({ t: "queenReturn" });
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

  const keepTurn = g.potsThisShot > 0 && !g.poisonThisShot && !g.deadPortThisShot;
  if (!keepTurn) returnQueenIfPending(g, ev);

  const remaining = g.pucks.filter((p) => p.alive && !p.sink).length;
  if (remaining === 0) {
    if (g.scores[0] === g.scores[1]) {
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

  if (keepTurn) {
    g.streak++;
    if (g.streak >= 2) ev.push({ t: "streak", n: g.streak, player: g.turn });
  } else {
    g.streak = 0;
    g.turn = 1 - g.turn;
    ev.push({ t: "turn", turn: g.turn });
  }
  g.phase = "aim";
  g.turnTimeLeft = TURN_FRAMES;
  ev.push({ t: "shotDone", shooter });
}

// no shot taken before the shot clock ran out — turn passes with no score,
// same as any other foul (and the queen, if pending, goes uncovered too)
function turnTimeoutPass(g, ev) {
  returnQueenIfPending(g, ev);
  g.streak = 0;
  g.turn = 1 - g.turn;
  g.turnTimeLeft = TURN_FRAMES;
  ev.push({ t: "turnTimeout" });
  ev.push({ t: "turn", turn: g.turn });
}

// ---------------- online sync ----------------
export function serialize(g) {
  return {
    pucks: g.pucks.map((p) => ({ x: p.x, y: p.y, alive: p.alive })),
    scores: [...g.scores],
    turn: g.turn,
    winner: g.winner,
    streak: g.streak,
    frame: g.frame,
    queenPending: g.queenPending,
    livePort: g.livePort,
    portShift: g.portShift,
    turnTimeLeft: g.turnTimeLeft,
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
  g.winner = snap.winner;
  g.streak = snap.streak;
  g.frame = snap.frame;
  g.queenPending = snap.queenPending ?? null;
  g.livePort = snap.livePort ?? g.livePort;
  g.portShift = snap.portShift ?? null;
  g.turnTimeLeft = snap.turnTimeLeft ?? TURN_FRAMES;
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
