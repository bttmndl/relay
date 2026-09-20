import { useEffect, useRef, useState } from "react";
import {
  createGame, launch, stepGame, serialize, applySync, aiChooseShot,
  getLivePorts, portRotateInfo, PNAME, QUEEN_POINTS, STREAK_BONUS_POINTS, TURN_SECONDS,
} from "./engine.js";
import { getSocket } from "./net.js";
import { hexToRgb } from "./themes.js";

const EMOTES = ["👍", "🔥", "😂", "😭"];

function makeSfx() {
  let ac = null;
  const ctx = () => {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ } }
    return ac;
  };
  const blip = (f0, f1, dur, type = "sine", vol = 0.09) => {
    const a = ctx(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), a.currentTime + dur);
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  };
  return {
    flick: () => blip(200, 420, 0.1, "triangle", 0.09),
    hit: (v) => blip(280 + Math.random() * 140, 190, 0.06, "square", Math.min(0.08, 0.02 + v * 0.005)),
    charge: () => blip(880, 1400, 0.08, "sine", 0.06),
    pot: () => { blip(520, 780, 0.12, "sine", 0.1); setTimeout(() => blip(780, 1170, 0.16, "sine", 0.09), 70); },
    poison: () => blip(300, 70, 0.5, "sawtooth", 0.12),
    reject: () => blip(240, 60, 0.22, "square", 0.09),
    win: () => { blip(330, 660, 0.3, "sine", 0.1); setTimeout(() => blip(495, 990, 0.4, "sine", 0.1), 150); },
  };
}

// mode: 'ai' | 'pvp' | 'online'
// online: { playerIndex, startAt } (socket via getSocket())
// theme: board theme object from themes.js — purely visual, no game logic
export default function RelayGame({ mode, online, onExit, theme }) {
  const players = theme.players;
  const C = {
    board: theme.ui.board, boardDeep: theme.ui.boardDeep, panel: theme.ui.panel, line: theme.ui.line,
    copper: theme.accent, hot: theme.ui.hot, neutral: theme.neutral, text: theme.ui.text, dim: theme.ui.dim,
  };
  const accentRgb = hexToRgb(theme.accent);
  const holeMidRgb = hexToRgb(theme.canvas.holeMid);
  const rootRef = useRef(null);
  const [w, setW] = useState(() => document.documentElement.clientWidth || window.innerWidth);
  useEffect(() => {
    const measure = () => {
      const el = rootRef.current;
      setW(el ? el.clientWidth : document.documentElement.clientWidth || window.innerWidth);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);
  const size = Math.min(440, w - 20);

  const [turn, setTurn] = useState(0);
  const [scores, setScores] = useState([0, 0]);
  const [winner, setWinner] = useState(null);
  const [callout, setCallout] = useState(null);
  const [waitingStart, setWaitingStart] = useState(mode === "online");
  const [oppLeft, setOppLeft] = useState(false);
  const [rematchState, setRematchState] = useState(null); // 'sent' | 'received'
  const [emoteFx, setEmoteFx] = useState(null);
  const [portsIn, setPortsIn] = useState(null); // seconds left in an active port-shift warning, or null
  const [turnSecLeft, setTurnSecLeft] = useState(TURN_SECONDS);
  const [turnToken, setTurnToken] = useState(0); // bumped whenever the shot clock resets, to restart its border animation

  const canvasRef = useRef(null);
  const G = useRef(null);
  const sfx = useRef(null);
  const arcs = useRef([]);
  const rejects = useRef([]);
  const drag = useRef(null);
  const me = mode === "online" ? online.playerIndex : null;

  const say = (text, col, ms = 1400) => {
    setCallout({ text, col });
    setTimeout(() => setCallout(null), ms);
  };

  // ---------------- init ----------------
  useEffect(() => {
    G.current = createGame(size);
    if (!sfx.current) sfx.current = makeSfx();
    arcs.current = [];
    rejects.current = [];
    setScores([0, 0]); setTurn(0); setWinner(null);
    setTurnSecLeft(TURN_SECONDS); setTurnToken(0);

    const beginMatch = () => {
      setWaitingStart(false);
      // the shot clock has been ticking since createGame() above — for online
      // matches that's up to ~1.5s of server start-buffer eaten from the very
      // first turn before the player could even see the board. Reset it now,
      // right as the match actually becomes visible/playable.
      if (G.current) G.current.turnTimeLeft = TURN_SECONDS * 60;
      setTurnSecLeft(TURN_SECONDS); setTurnToken((t) => t + 1);
      say(
        mode === "online"
          ? me === 0 ? "YOU ARE VOLT — you shoot first" : "YOU ARE AMP — Volt shoots first"
          : "VOLT first — everything you touch becomes yours",
        players[mode === "online" ? me : 0], 2400);
    };

    if (mode === "online") {
      const delay = Math.max(0, online.startAt - Date.now());
      const t = setTimeout(beginMatch, delay);
      return () => clearTimeout(t);
    }
    beginMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- online socket wiring ----------------
  useEffect(() => {
    if (mode !== "online") return;
    const socket = getSocket();
    const onFlick = ({ idx, ang, v }) => {
      const g = G.current;
      if (!g) return;
      const ev = [];
      launch(g, idx, ang, v, ev);
      drainEvents(ev);
    };
    const onSync = (snap) => {
      const g = G.current;
      if (!g) return;
      applySync(g, snap);
      setScores([...g.scores]); setTurn(g.turn);
      if (g.winner !== null && winner === null) setWinner(g.winner);
    };
    const onLeft = () => { setOppLeft(true); setWinner(me); sfx.current?.win(); };
    const onRematchReq = () => setRematchState("received");
    const onEmote = ({ emote }) => {
      setEmoteFx({ emote, side: 1 - me, key: Date.now() });
      setTimeout(() => setEmoteFx(null), 1800);
    };
    socket.on("opponentFlick", onFlick);
    socket.on("syncState", onSync);
    socket.on("opponentLeft", onLeft);
    socket.on("rematchRequested", onRematchReq);
    socket.on("emote", onEmote);
    return () => {
      socket.off("opponentFlick", onFlick);
      socket.off("syncState", onSync);
      socket.off("opponentLeft", onLeft);
      socket.off("rematchRequested", onRematchReq);
      socket.off("emote", onEmote);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, me, winner]);

  // ---------------- event drain (engine → ui/sfx) ----------------
  const drainEvents = (ev) => {
    const g = G.current;
    ev.forEach((e) => {
      if (e.t === "flick") sfx.current?.flick();
      else if (e.t === "hit") sfx.current?.hit(e.v);
      else if (e.t === "charge") { arcs.current.push({ ...e, t: 1 }); sfx.current?.charge(); }
      else if (e.t === "pot") { sfx.current?.pot(); setScores([...g.scores]); }
      else if (e.t === "poison") {
        sfx.current?.poison(); setScores([...g.scores]);
        say("POISON! STRIKER SUNK", players[e.player], 1500);
      }
      else if (e.t === "deadPort") {
        sfx.current?.reject();
        rejects.current.push({ x: e.x, y: e.y, t: 1 });
        if (e.penalized) {
          setScores([...g.scores]);
          say("WRONG HOLE! −1", "#FF6A6A", 1500);
        } else {
          say("PORT OFFLINE — RETURNED", "#FF6A6A", 1400);
        }
      }
      else if (e.t === "queenPot") {
        sfx.current?.win(); setScores([...g.scores]);
        say(`QUEEN! +${QUEEN_POINTS}`, theme.canvas.queen, 1800);
      }
      else if (e.t === "turnTimeout") {
        sfx.current?.reject();
        setTurnToken((t) => t + 1);
        say("TIME'S UP — TURN PASSED", "#FF6A6A", 1500);
      }
      else if (e.t === "streak") say(`RELAY ×${e.n}`, players[e.player], 1200);
      else if (e.t === "streakBonus") {
        setScores([...g.scores]);
        say(`${e.n} IN A ROW! +${STREAK_BONUS_POINTS} BONUS`, players[e.player], 1600);
      }
      else if (e.t === "turn") setTurn(e.turn);
      else if (e.t === "end") { sfx.current?.win(); setTimeout(() => setWinner(e.winner), 600); }
      else if (e.t === "shotDone") {
        setTurnToken((t) => t + 1);
        if (mode === "online" && e.shooter === me) {
          getSocket().emit("syncState", serialize(g));
        }
        if (mode === "ai" && g.phase === "aim" && g.turn === 1 && g.winner === null) {
          setTimeout(() => {
            const gg = G.current;
            if (!gg || gg.phase !== "aim" || gg.turn !== 1 || gg.winner !== null) return;
            const shot = aiChooseShot(gg);
            if (shot) {
              const evs = [];
              launch(gg, shot.idx, shot.ang, shot.v, evs);
              drainEvents(evs);
            }
          }, 700);
        }
      }
    });
  };

  // ---------------- fixed-timestep loop + render ----------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const STEP = 1000 / 60;
    let last = performance.now();
    let acc = 0;
    let pulse = 0;
    let lastPortsIn = -1;
    let lastTurnSec = -1;
    let raf;

    const loop = (now) => {
      const g = G.current;
      if (!g) return;
      acc += Math.min(100, now - last);
      last = now;
      let guard = 0;
      while (acc >= STEP && guard < 6) {
        const ev = [];
        stepGame(g, ev);
        if (ev.length) drainEvents(ev);
        acc -= STEP;
        guard++;
      }
      pulse += 0.03;
      arcs.current.forEach((a) => (a.t -= 0.06));
      arcs.current = arcs.current.filter((a) => a.t > 0);
      rejects.current.forEach((r) => (r.t -= 0.025));
      rejects.current = rejects.current.filter((r) => r.t > 0);
      render(ctx, g, pulse);
      const { pending } = portRotateInfo(g);
      const nextPortsIn = pending ? Math.ceil(pending.framesLeft / 60) : null;
      if (nextPortsIn !== lastPortsIn) { lastPortsIn = nextPortsIn; setPortsIn(nextPortsIn); }
      const nextTurnSec = g.phase === "aim" ? Math.ceil(g.turnTimeLeft / 60) : TURN_SECONDS;
      if (nextTurnSec !== lastTurnSec) { lastTurnSec = nextTurnSec; setTurnSecLeft(nextTurnSec); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const render = (ctx, g, pulse) => {
    const { S, R, pad } = g;
    ctx.clearRect(0, 0, S, S);
    drawBoardStyle(ctx, g, pulse);

    // ports — only the "live" one (getLivePorts) accepts a pot; it's
    // whichever pocket is currently hardest to reach, and it flickers only
    // in the last moment of an active shift warning
    const liveGates = getLivePorts(g);
    const { pending } = portRotateInfo(g);
    const flicker = pending && pending.framesLeft < 45 && Math.floor(pending.framesLeft / 4) % 2 === 0;
    g.pockets.forEach((pk, pi) => {
      const isLive = liveGates.includes(pi) && !flicker;
      const glow = isLive ? theme.canvas.liveGlow : C.copper;
      const grad = ctx.createRadialGradient(pk.x, pk.y, 1, pk.x, pk.y, g.pocketR);
      grad.addColorStop(0, theme.canvas.holeInner);
      grad.addColorStop(0.75, theme.canvas.holeMid);
      grad.addColorStop(1, `rgba(${holeMidRgb.r},${holeMidRgb.g},${holeMidRgb.b},0)`);
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, g.pocketR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, g.pocketR * 0.72, 0, Math.PI * 2);
      ctx.strokeStyle = glow;
      ctx.lineWidth = isLive ? 2.6 : 1.4;
      ctx.globalAlpha = isLive ? 1 : 0.35;
      ctx.shadowColor = glow;
      ctx.shadowBlur = isLive ? 14 + Math.sin(pulse * 3) * 5 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      if (isLive) {
        ctx.beginPath();
        ctx.arc(pk.x, pk.y, g.pocketR * 0.72 * (0.5 + 0.15 * Math.sin(pulse * 3)), 0, Math.PI * 2);
        ctx.strokeStyle = `${theme.canvas.liveGlow}66`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    // aim preview
    if (drag.current && g.phase === "aim") {
      const d0 = drag.current;
      const pk = g.pucks[d0.idx];
      const ax = pk.x - d0.cx, ay = pk.y - d0.cy;
      const pow = Math.min(Math.hypot(ax, ay), S * 0.32);
      if (pow > 8) {
        const ang = Math.atan2(ay, ax);
        const v = (pow / (S * 0.32)) * S * 0.036;
        let sx = pk.x, sy = pk.y, svx = Math.cos(ang) * v, svy = Math.sin(ang) * v;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        let hit = null, doom = null, reject = null;
        for (let k = 0; k < 120; k++) {
          sx += svx; sy += svy;
          svx *= 0.985; svy *= 0.985;
          const lo = pad + R, hi = S - pad - R;
          if (sx < lo) { sx = lo; svx *= -0.82; }
          if (sx > hi) { sx = hi; svx *= -0.82; }
          if (sy < lo) { sy = lo; svy *= -0.82; }
          if (sy > hi) { sy = hi; svy *= -0.82; }
          for (let pti = 0; pti < g.pockets.length; pti++) {
            const pt = g.pockets[pti];
            if (Math.hypot(sx - pt.x, sy - pt.y) < g.pocketR * 0.72) {
              if (liveGates.includes(pti)) doom = { x: pt.x, y: pt.y };
              else reject = { x: pt.x, y: pt.y };
              break;
            }
          }
          if (doom || reject) break;
          for (let j = 0; j < g.pucks.length; j++) {
            const o = g.pucks[j];
            if (j === d0.idx || !o.alive || o.sink) continue;
            if (Math.hypot(o.x - sx, o.y - sy) < R * 2) { hit = { x: sx, y: sy }; break; }
          }
          if (k % 2 === 0) ctx.lineTo(sx, sy);
          if (hit || Math.hypot(svx, svy) < 0.15) break;
        }
        ctx.strokeStyle = doom ? "rgba(255,80,80,0.9)" : reject ? "rgba(255,160,46,0.85)" : `${players[g.turn]}AA`;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (doom) {
          ctx.fillStyle = "rgba(255,80,80,0.95)";
          ctx.font = `700 ${Math.round(R * 1.1)}px 'Space Mono', monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("☠", doom.x, doom.y);
        } else if (reject) {
          ctx.fillStyle = "rgba(255,160,46,0.95)";
          ctx.font = `700 ${Math.round(R * 1.1)}px 'Space Mono', monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("⊘", reject.x, reject.y);
        } else if (hit) {
          ctx.beginPath();
          ctx.arc(hit.x, hit.y, R * 0.7, 0, Math.PI * 2);
          ctx.strokeStyle = C.hot;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(pk.x, pk.y);
        ctx.lineTo(pk.x - Math.cos(ang) * pow * 0.5, pk.y - Math.sin(ang) * pow * 0.5);
        ctx.strokeStyle = `${players[g.turn]}55`;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }

    // charge arcs
    arcs.current.forEach((a) => {
      ctx.save();
      ctx.shadowColor = C.hot;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      for (let s = 1; s <= 5; s++) {
        const u = s / 5;
        const j = 7 * (1 - Math.abs(u - 0.5) * 2);
        ctx.lineTo(a.x1 + (a.x2 - a.x1) * u + (Math.random() - 0.5) * j, a.y1 + (a.y2 - a.y1) * u + (Math.random() - 0.5) * j);
      }
      ctx.strokeStyle = `rgba(244,255,240,${a.t * 0.9})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      ctx.shadowBlur = 0;
    });

    // dead-port rejection fizzle (port → center)
    rejects.current.forEach((r) => {
      ctx.save();
      ctx.shadowColor = "#FF6A6A";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      for (let s = 1; s <= 6; s++) {
        const u = s / 6;
        const j = 9 * (1 - Math.abs(u - 0.5) * 2);
        ctx.lineTo(r.x + (g.cx - r.x) * u + (Math.random() - 0.5) * j, r.y + (g.cy - r.y) * u + (Math.random() - 0.5) * j);
      }
      ctx.strokeStyle = `rgba(255,106,106,${Math.max(0, r.t) * 0.85})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      ctx.shadowBlur = 0;
    });

    // pucks
    g.pucks.forEach((p, i) => {
      if (!p.alive) return;
      const scale = p.sink ? p.sink.s : 1;
      const rad = R * scale;
      const isQueenVisible = p.isQueen && !p.striker;
      const col = p.striker ? players[g.turn] : isQueenVisible ? theme.canvas.queen : p.charge !== null ? players[p.charge] : C.neutral;
      const hot = p.striker || p.charge !== null || isQueenVisible;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.shadowColor = col;
      ctx.shadowBlur = hot ? 16 : 4;
      const grad = ctx.createRadialGradient(-rad * 0.3, -rad * 0.3, 1, 0, 0, rad);
      grad.addColorStop(0, hot ? theme.canvas.puckHot : theme.canvas.puckCold);
      grad.addColorStop(1, theme.canvas.puckDeep);
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 2.4 * scale;
      ctx.strokeStyle = col;
      ctx.globalAlpha = hot ? 1 : 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, rad * (p.striker ? 0.34 : 0.24), 0, Math.PI * 2);
      ctx.fillStyle = p.striker ? C.hot : col;
      ctx.globalAlpha = hot ? 1 : 0.4;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (drag.current && drag.current.idx === i) {
        ctx.beginPath();
        ctx.arc(0, 0, rad + 5, 0, Math.PI * 2);
        ctx.strokeStyle = C.hot;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (isQueenVisible && !p.sink) {
        ctx.beginPath();
        ctx.arc(0, 0, rad * (1.2 + 0.08 * Math.sin(pulse * 3)), 0, Math.PI * 2);
        ctx.strokeStyle = theme.canvas.liveGlow;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      ctx.shadowBlur = 0;
      const spd = Math.hypot(p.vx, p.vy);
      if (spd > 1.4 && hot && !p.sink) {
        for (let k = 1; k <= 5; k++) {
          ctx.beginPath();
          ctx.arc(p.x - p.vx * k * 1.2, p.y - p.vy * k * 1.2, rad * (1 - k * 0.15), 0, Math.PI * 2);
          ctx.fillStyle = `${col}${Math.round(28 - k * 4).toString(16).padStart(2, "0")}`;
          ctx.fill();
        }
      }
    });
  };

  function rr(c, x, y, wd, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + wd, y, x + wd, y + h, r);
    c.arcTo(x + wd, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + wd, y, r);
    c.closePath();
  }

  function drawDiamond(ctx, x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
  }

  // ---------------- board designs (classic, selectable) ----------------
  function drawBoardStyle(ctx, g, pulse) {
    if (theme.boardStyle === "felt") drawFeltBoard(ctx, g);
    else if (theme.boardStyle === "deco") drawDecoBoard(ctx, g, pulse);
    else drawCarromBoard(ctx, g);
  }

  // wooden rail + cream court, corner arrow guides, center queen spot
  function drawCarromBoard(ctx, g) {
    const { S, R, pad, cx, cy } = g;
    const outerX = pad * 0.18, outerY = pad * 0.18;
    const outerW = S - outerX * 2, outerH = S - outerY * 2;

    const railGrad = ctx.createLinearGradient(0, 0, S, S);
    railGrad.addColorStop(0, theme.canvas.rail);
    railGrad.addColorStop(1, theme.canvas.railDeep);
    ctx.fillStyle = railGrad;
    rr(ctx, outerX, outerY, outerW, outerH, 18);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.8;
    rr(ctx, outerX, outerY, outerW, outerH, 18);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const railW = pad * 0.55;
    const innerX = outerX + railW, innerY = outerY + railW;
    const innerW = S - innerX * 2, innerH = S - innerY * 2;
    const courtGrad = ctx.createLinearGradient(innerX, innerY, innerX + innerW, innerY + innerH);
    courtGrad.addColorStop(0, theme.canvas.surfaceTop);
    courtGrad.addColorStop(1, theme.canvas.surfaceBottom);
    ctx.fillStyle = courtGrad;
    rr(ctx, innerX, innerY, innerW, innerH, 10);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.7;
    rr(ctx, innerX, innerY, innerW, innerH, 10);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // corner arrow guides pointing into each pocket
    ctx.strokeStyle = C.copper;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.75;
    g.pockets.forEach((pk) => {
      const dx = Math.sign(cx - pk.x), dy = Math.sign(cy - pk.y);
      ctx.beginPath();
      ctx.moveTo(pk.x + dx * R * 3.4, pk.y);
      ctx.lineTo(pk.x + dx * R * 1.6, pk.y + dy * R * 1.6);
      ctx.lineTo(pk.x, pk.y + dy * R * 3.4);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // center circle + queen spot
    ctx.beginPath();
    ctx.arc(cx, cy, R * 2.3, 0, Math.PI * 2);
    ctx.strokeStyle = C.copper;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "#8B1E2B";
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // green baize + mahogany rail, gold sight diamonds, baulk arc
  function drawFeltBoard(ctx, g) {
    const { S, R, pad, cx } = g;
    const outerX = pad * 0.18, outerY = pad * 0.18;
    const outerW = S - outerX * 2, outerH = S - outerY * 2;

    const railGrad = ctx.createLinearGradient(0, 0, S, S);
    railGrad.addColorStop(0, theme.canvas.rail);
    railGrad.addColorStop(1, theme.canvas.railDeep);
    ctx.fillStyle = railGrad;
    rr(ctx, outerX, outerY, outerW, outerH, 14);
    ctx.fill();

    const railW = pad * 0.6;
    const innerX = outerX + railW, innerY = outerY + railW;
    const innerW = S - innerX * 2, innerH = S - innerY * 2;
    const feltGrad = ctx.createLinearGradient(innerX, innerY, innerX + innerW, innerY + innerH);
    feltGrad.addColorStop(0, theme.canvas.surfaceTop);
    feltGrad.addColorStop(1, theme.canvas.surfaceBottom);
    ctx.fillStyle = feltGrad;
    rr(ctx, innerX, innerY, innerW, innerH, 8);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.6;
    rr(ctx, innerX, innerY, innerW, innerH, 8);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // rail sight diamonds (like a pool table's cushion markers)
    ctx.fillStyle = C.copper;
    ctx.globalAlpha = 0.85;
    const mid = S / 2;
    const railMid = outerY + railW / 2;
    [[mid, railMid], [mid, S - railMid], [railMid, mid], [S - railMid, mid]]
      .forEach(([x, y]) => drawDiamond(ctx, x, y, 4));
    ctx.globalAlpha = 1;

    // baulk lines across the near/far rails, each "D" bulging toward its own rail
    const baulkMargin = innerW * 0.12;
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5;
    [
      { y: innerY + innerH * 0.82, sweep: [0, Math.PI] },       // bottom, D bulges down
      { y: innerY + innerH * 0.18, sweep: [Math.PI, Math.PI * 2] }, // top, D bulges up
    ].forEach(({ y, sweep }) => {
      ctx.beginPath();
      ctx.moveTo(innerX + baulkMargin, y);
      ctx.lineTo(innerX + innerW - baulkMargin, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, y, R * 2.2, sweep[0], sweep[1]);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  // onyx marble + gold Art Deco lattice, sunburst corner fans
  function drawDecoBoard(ctx, g, pulse) {
    const { S, R, pad, cx, cy } = g;
    const outerX = pad * 0.3, outerY = pad * 0.3;
    const outerW = S - outerX * 2, outerH = S - outerY * 2;

    const surfGrad = ctx.createLinearGradient(0, 0, S, S);
    surfGrad.addColorStop(0, theme.canvas.surfaceTop);
    surfGrad.addColorStop(1, theme.canvas.surfaceBottom);
    ctx.fillStyle = surfGrad;
    rr(ctx, outerX, outerY, outerW, outerH, 16);
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.9;
    rr(ctx, outerX, outerY, outerW, outerH, 16);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    rr(ctx, outerX + 7, outerY + 7, outerW - 14, outerH - 14, 12);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // diagonal gold lattice
    ctx.strokeStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.16)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(outerX, outerY); ctx.lineTo(outerX + outerW, outerY + outerH);
    ctx.moveTo(outerX + outerW, outerY); ctx.lineTo(outerX, outerY + outerH);
    ctx.moveTo(cx, outerY); ctx.lineTo(outerX + outerW, cy);
    ctx.moveTo(outerX + outerW, cy); ctx.lineTo(cx, outerY + outerH);
    ctx.moveTo(cx, outerY + outerH); ctx.lineTo(outerX, cy);
    ctx.moveTo(outerX, cy); ctx.lineTo(cx, outerY);
    ctx.stroke();

    // sunburst fans at each corner
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    const corners = [
      [outerX, outerY, 0, Math.PI / 2],
      [outerX + outerW, outerY, Math.PI / 2, Math.PI],
      [outerX, outerY + outerH, -Math.PI / 2, 0],
      [outerX + outerW, outerY + outerH, Math.PI, Math.PI * 1.5],
    ];
    corners.forEach(([x, y, a0, a1]) => {
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(x, y, R * i * 0.75, a0, a1);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;

    // slow pulsing center ring
    ctx.beginPath();
    ctx.arc(cx, cy, R * 2 + Math.sin(pulse * 2) * 2, 0, Math.PI * 2);
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---------------- input ----------------
  const canShoot = () => {
    const g = G.current;
    if (!g || g.phase !== "aim" || g.winner !== null || waitingStart || oppLeft) return false;
    if (mode === "ai") return g.turn === 0;
    if (mode === "online") return g.turn === me;
    return true;
  };
  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const onDown = (e) => {
    if (!canShoot()) return;
    const g = G.current;
    const { x, y } = getPos(e);
    let best = -1, bd = 1e9;
    g.pucks.forEach((p, i) => {
      if (!p.alive || p.sink) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < g.R * 2.4 && d < bd) { bd = d; best = i; }
    });
    if (best >= 0) {
      drag.current = { idx: best, cx: x, cy: y };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };
  const onMove = (e) => {
    if (!drag.current) return;
    const { x, y } = getPos(e);
    drag.current.cx = x;
    drag.current.cy = y;
  };
  const onUp = () => {
    const g = G.current;
    const d0 = drag.current;
    drag.current = null;
    if (!g || !d0 || !canShoot()) return;
    const pk = g.pucks[d0.idx];
    const ax = pk.x - d0.cx, ay = pk.y - d0.cy;
    const pow = Math.min(Math.hypot(ax, ay), g.S * 0.32);
    if (pow > 12) {
      const ang = Math.atan2(ay, ax);
      const v = (pow / (g.S * 0.32)) * g.S * 0.036;
      const ev = [];
      if (launch(g, d0.idx, ang, v, ev)) {
        drainEvents(ev);
        if (mode === "online") getSocket().emit("flick", { idx: d0.idx, ang, v });
      }
    }
  };

  // ---------------- ui bits ----------------
  const btn = (bg, col) => ({
    fontFamily: "'Audiowide', sans-serif", fontSize: 14, letterSpacing: 2,
    color: col, background: bg, border: `2px solid ${col}`, borderRadius: 10,
    padding: "14px 28px", cursor: "pointer", boxShadow: `0 0 18px ${col}44`,
  });
  const nameFor = (p) => {
    if (mode === "ai" && p === 1) return "AI";
    if (mode === "online") return p === me ? `${PNAME[p]} (YOU)` : PNAME[p];
    return PNAME[p];
  };
  const winLabel = () => {
    if (winner === "draw") return "DRAW";
    if (oppLeft) return "OPPONENT LEFT — YOU WIN";
    if (mode === "online") return winner === me ? "YOU WIN" : "YOU LOSE";
    if (mode === "ai" && winner === 1) return "AI WINS";
    return `${PNAME[winner]} WINS`;
  };
  const handleRematch = () => {
    if (mode === "online") {
      getSocket().emit("rematch");
      setRematchState("sent");
    } else {
      onExit("restart");
    }
  };

  return (
    <div ref={rootRef} style={{ minHeight: "100vh", width: "100%", background: `linear-gradient(180deg, ${C.board}, ${C.boardDeep})`, color: C.text, fontFamily: "'Space Mono', monospace", display: "flex", flexDirection: "column", alignItems: "center", paddingBottom: 40, userSelect: "none", WebkitUserSelect: "none", boxSizing: "border-box" }}>
      <style>{`
        @keyframes rlIn { from{opacity:0; transform:scale(.85)} to{opacity:1; transform:scale(1)} }
        @keyframes rlPulse { 0%,100%{opacity:.55} 50%{opacity:1} }
        @keyframes rlCall { 0%{opacity:0; transform:translateX(-50%) scale(.7)} 15%{opacity:1; transform:translateX(-50%) scale(1.08)} 30%{transform:translateX(-50%) scale(1)} 80%{opacity:1} 100%{opacity:0; transform:translateX(-50%) translateY(-12px)} }
        @keyframes rlEmote {
          0%{opacity:0; transform:translateX(-50%) translateY(8px) scale(.6)}
          20%{opacity:1; transform:translateX(-50%) translateY(0) scale(1.15)}
          35%{transform:translateX(-50%) translateY(0) scale(1)}
          75%{opacity:1; transform:translateX(-50%) translateY(-3px) scale(1)}
          100%{opacity:0; transform:translateX(-50%) translateY(-10px) scale(.92)}
        }
        @media (prefers-reduced-motion: reduce){ *{animation:none !important} }
      `}</style>

      {/* HUD */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: size, padding: "30px 4px 8px", gap: 8 }}>
        {[0, 1].map((p) => (
          <div key={p} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${turn === p && winner === null ? players[p] : C.line}`, boxShadow: turn === p && winner === null ? `0 0 14px ${players[p]}44` : "none", minWidth: 88, position: "relative", overflow: "visible" }}>
            <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 8, letterSpacing: 1.5, color: players[p], whiteSpace: "nowrap" }}>{nameFor(p)}</div>
            <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 24, color: players[p] }}>{scores[p]}</div>
            {emoteFx && emoteFx.side === p && (
              <div key={emoteFx.key} style={{ position: "absolute", top: -18, left: "50%", transform: "translateX(-50%)", fontSize: 24, animation: "rlEmote 1.8s ease-out forwards", pointerEvents: "none" }}>{emoteFx.emote}</div>
            )}
            {turn === p && winner === null && !waitingStart && (
              <svg key={`clock-${turnToken}`} width="100%" height="100%" style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}>
                <rect
                  x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)"
                  rx="9" ry="9" fill="none"
                  strokeWidth="2.5"
                  pathLength="100"
                  strokeDasharray="100"
                  style={{
                    stroke: turnSecLeft <= 5 ? "#FF6A6A" : players[p],
                    strokeDashoffset: Math.max(0, Math.min(100, (1 - turnSecLeft / TURN_SECONDS) * 100)),
                    transition: "stroke-dashoffset 1.05s linear, stroke 0.3s ease-out",
                  }}
                />
              </svg>
            )}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", top: 18, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
        {winner === null && !waitingStart && portsIn !== null && (
          <div style={{ fontSize: 8, letterSpacing: 1, color: portsIn <= 3 ? "#FF6A6A" : C.copper, marginTop: 2, animation: portsIn <= 3 ? "rlPulse 0.6s infinite" : "none" }}>
            PORTS SHIFT {portsIn}s
          </div>
        )}
      </div>

      <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 10, letterSpacing: 3, color: players[turn], margin: "2px 0 8px", animation: "rlPulse 1.6s infinite", minHeight: 14 }}>
        {winner !== null ? " "
          : waitingStart ? "SYNCING…"
          : mode === "ai" && turn === 1 ? "AI IS ROUTING…"
          : mode === "online" ? (turn === me ? "YOUR SHOT — FLICK ANY PUCK" : "OPPONENT IS AIMING…")
          : `${PNAME[turn]} — FLICK ANY PUCK`}
      </div>
      <div style={{ position: "relative" }}>
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size, touchAction: "none", cursor: "crosshair", display: "block" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {callout && (
          <div style={{ position: "absolute", top: "6%", left: "50%", transform: "translateX(-50%)", fontFamily: "'Audiowide', sans-serif", fontSize: 13, letterSpacing: 3, color: callout.col, textShadow: `0 0 12px ${callout.col}`, animation: "rlCall 1.5s ease-out forwards", whiteSpace: "nowrap", pointerEvents: "none" }}>
            {callout.text}
          </div>
        )}
      </div>

      {/* controls row */}
      <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
        {mode === "online" ? (
          EMOTES.map((em) => (
            <button key={em} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 18, padding: "6px 10px", cursor: "pointer" }}
              onClick={() => {
                getSocket().emit("emote", { emote: em });
                setEmoteFx({ emote: em, side: me, key: Date.now() });
                setTimeout(() => setEmoteFx(null), 1800);
              }}>
              {em}
            </button>
          ))
        ) : (
          <button style={{ ...btn(C.panel, C.dim), padding: "8px 18px", fontSize: 10, boxShadow: "none", border: `1px solid ${C.line}` }} onClick={() => onExit("restart")}>RESTART</button>
        )}
        <button style={{ ...btn(C.panel, C.dim), padding: "8px 18px", fontSize: 10, boxShadow: "none", border: `1px solid ${C.line}` }} onClick={() => onExit("menu")}>
          {mode === "online" ? "LEAVE" : "MENU"}
        </button>
      </div>

      {/* win overlay */}
      {winner !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(3,8,5,0.88)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, zIndex: 10, animation: "rlIn .35s ease-out", padding: 20, textAlign: "center" }}>
          <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 12, letterSpacing: 5, color: C.dim }}>
            {winner === "draw" ? "CIRCUIT BALANCED" : "FINAL"}
          </div>
          <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: "clamp(26px, 7vw, 44px)", letterSpacing: 3, color: winner === "draw" ? C.text : players[winner === "draw" ? 0 : winner], textShadow: winner === "draw" ? "none" : `0 0 24px ${players[winner]}` }}>
            {winLabel()}
          </div>
          <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 20, color: C.dim }}>
            <span style={{ color: players[0] }}>{scores[0]}</span> — <span style={{ color: players[1] }}>{scores[1]}</span>
          </div>
          <div style={{ height: 10 }} />
          {!oppLeft && (
            <button
              style={btn("#0E2415", winner === "draw" ? C.text : players[winner === "draw" ? 0 : winner])}
              onClick={handleRematch}
              disabled={rematchState === "sent"}
            >
              {mode !== "online" ? "REMATCH"
                : rematchState === "sent" ? "WAITING FOR RIVAL…"
                : rematchState === "received" ? "ACCEPT REMATCH"
                : "REMATCH"}
            </button>
          )}
          <button style={{ ...btn(C.panel, C.dim), boxShadow: "none", border: `1px solid ${C.line}`, fontSize: 11, padding: "10px 20px" }} onClick={() => onExit("menu")}>MENU</button>
        </div>
      )}
    </div>
  );
}
