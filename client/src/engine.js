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

// ---------------- scoring ----------------
// a regular puck is worth 1 point. The queen — the special center puck —
// is worth QUEEN_POINTS on its own, no extra condition. Potting 3 (or 6, 9…)
// pucks in a row within one unbroken turn banks an extra streak bonus.
export const QUEEN_POINTS = 5;
export const STREAK_BONUS_EVERY = 3;
export const STREAK_BONUS_POINTS = 1;

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

// where's the single hardest open spot on the board to pot INTO, given the
// current layout and live pocket? Used once, at setup, to place the queen.
// Scans a grid of candidate points (skipping anything that would overlap a
// puck, a pocket, or a wall) and scores each one exactly like pocketEase
// does — the best shot any live puck could currently take at a target
// sitting there. Lowest wins.
function hardestSpawnSpot(g) {
  const pk = g.pockets[g.livePort];
  const sources = g.pucks.filter((p) => p.alive && !p.sink && !p.isQueen);
  const lo = g.pad + g.R * 1.5, hi = g.S - g.pad - g.R * 1.5;
  const step = g.R * 2.4;
  let best = null;
  for (let x = lo; x <= hi; x += step) {
    for (let y = lo; y <= hi; y += step) {
      let blocked = g.pockets.some((p) => Math.hypot(x - p.x, y - p.y) < g.pocketR * 1.6);
      if (!blocked) blocked = sources.some((p) => Math.hypot(x - p.x, y - p.y) < g.R * 2.3);
      if (blocked) continue;
      let ease = 0;
      sources.forEach((s) => {
        const stx = x - s.x, sty = y - s.y;
        const std = Math.hypot(stx, sty);
        if (std < g.R * 2.2) return;
        const tpx = pk.x - x, tpy = pk.y - y;
        const tpd = Math.hypot(tpx, tpy);
        const dot = (stx * tpx + sty * tpy) / (std * tpd || 1);
        if (dot <= 0) return;
        const e = dot * 2.2 - std / g.S - tpd / (g.S * 2);
        if (e > ease) ease = e;
      });
      if (!best || ease < best.ease) best = { x, y, ease };
    }
  }
  return best ? { x: best.x, y: best.y } : { x: g.cx, y: g.cy };
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
    streak: 0,
    settleFrames: 0,
    resolveTime: 0,
    frame: 0,
    livePort: 0,
    portShift: null,
    turnTimeLeft: TURN_FRAMES,
  };
  // pick the live pocket from the 16 regular pucks first, then drop the
  // queen on whichever open spot is hardest to pot into that pocket — a
  // one-time placement. Once potted, it's gone for good, same as any puck.
  g.livePort = hardestPocket(g);
  const spot = hardestSpawnSpot(g);
  const queen = mkPuck(spot.x, spot.y);
  queen.isQueen = true;
  pucks.push(queen);
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
          // dead port: rejected and turn passes regardless of any pots this shot, plus
          // costs the shooter 1 point for the wrong-hole shot (never below 0). A regular
          // puck gets sent back to center; the queen isn't "potted" by this at all, so it
          // just stays roughly where it is — nudged clear of the pocket mouth so it can't
          // keep re-triggering the same dead port next frame.
          if (p.isQueen) {
            const dx = p.x - pk.x, dy = p.y - pk.y;
            const d = Math.hypot(dx, dy) || 1;
            const clear = g.pocketR * 1.3;
            const lo = g.pad + g.R, hi = g.S - g.pad - g.R;
            p.x = Math.min(hi, Math.max(lo, pk.x + (dx / d) * clear));
            p.y = Math.min(hi, Math.max(lo, pk.y + (dy / d) * clear));
          } else {
            p.x = g.cx; p.y = g.cy;
          }
          p.vx = 0; p.vy = 0;
          p.striker = false;
          p.charge = null;
          g.deadPortThisShot = true;
          const penalized = g.scores[g.turn] > 0;
          if (penalized) g.scores[g.turn]--;
          ev.push({ t: "deadPort", x: pk.x, y: pk.y, player: g.turn, penalized });
        } else if (p.striker) {
          p.sink = { px: pk.x, py: pk.y, s: 1 };
          g.poisonThisShot = true;
          const opp = 1 - g.turn;
          g.scores[opp]++;
          ev.push({ t: "poison", player: opp });
        } else {
          p.sink = { px: pk.x, py: pk.y, s: 1 };
          const scorer = p.charge !== null ? p.charge : g.turn;
          const pts = p.isQueen ? QUEEN_POINTS : 1;
          g.potsThisShot++;
          g.scores[scorer] += pts;
          ev.push({ t: p.isQueen ? "queenPot" : "pot", player: scorer, pts });
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

// the most points either player could still conceivably bank from what's
// left on the board — every remaining puck at best-case value, plus every
// streak bonus that many pucks could theoretically string together in one
// unbroken turn. Deliberately generous: if even THIS can't close the gap,
// the outcome is truly locked in.
function maxRemainingPoints(g) {
  let n = 0, hasQueen = false;
  g.pucks.forEach((p) => {
    if (!p.alive || p.sink) return;
    if (p.isQueen) { hasQueen = true; } else { n++; }
  });
  const base = n + (hasQueen ? QUEEN_POINTS : 0);
  const bonus = Math.floor((n + (hasQueen ? 1 : 0)) / STREAK_BONUS_EVERY) * STREAK_BONUS_POINTS;
  return base + bonus;
}

// mercy rule: once the trailing player can no longer catch up even in the
// best possible case (they clear the whole board, the leader scores nothing
// more), there's no point grinding out the rest of the match — end it now.
function checkClinched(g, ev, shooter) {
  if (g.winner !== null) return false;
  const maxLeft = maxRemainingPoints(g);
  if (g.scores[0] > g.scores[1] + maxLeft) { endMatch(g, 0, ev); ev.push({ t: "shotDone", shooter }); return true; }
  if (g.scores[1] > g.scores[0] + maxLeft) { endMatch(g, 1, ev); ev.push({ t: "shotDone", shooter }); return true; }
  return false;
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
  let streakBonusN = 0;
  if (keepTurn) {
    g.streak++;
    if (g.streak % STREAK_BONUS_EVERY === 0) {
      g.scores[g.turn] += STREAK_BONUS_POINTS;
      streakBonusN = g.streak;
    }
  } else {
    g.streak = 0;
  }

  // scores (including any streak bonus just banked) are final for this shot —
  // check both possible endings before deciding whether play continues
  if (checkClinched(g, ev, shooter)) return;

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
    if (g.streak >= 2 && !streakBonusN) ev.push({ t: "streak", n: g.streak, player: g.turn });
    if (streakBonusN) ev.push({ t: "streakBonus", n: streakBonusN, player: g.turn });
  } else {
    g.turn = 1 - g.turn;
    ev.push({ t: "turn", turn: g.turn });
  }
  g.phase = "aim";
  g.turnTimeLeft = TURN_FRAMES;
  ev.push({ t: "shotDone", shooter });
}

// no shot taken before the shot clock ran out — turn passes with no score,
// same as any other foul
function turnTimeoutPass(g, ev) {
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
  g.livePort = snap.livePort ?? g.livePort;
  g.portShift = snap.portShift ?? null;
  g.turnTimeLeft = snap.turnTimeLeft ?? TURN_FRAMES;
  g.phase = snap.winner !== null ? "done" : "aim";
}

// ---------------- AI (local play only) ----------------
// note: the gate below is deliberately loose (any forward alignment, not a
// "confident" one) because the live pocket is always whichever one is
// currently hardest — a strict quality bar meant the AI would routinely
// find nothing worth trying and default to an aimless nudge, so it could
// go an entire match without scoring or making real progress.
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
        if (dot > 0 && std > g.R * 2.2) {
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
