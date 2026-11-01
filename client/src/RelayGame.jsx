import { useEffect, useRef, useState } from "react";
import {
  createGame, launch, stepGame, serialize, applySync, aiChooseShot,
  getLivePorts, portRotateInfo, PNAME, QUEEN_POINTS, STREAK_BONUS_POINTS, TURN_SECONDS, ONLINE_BOARD,
} from "./engine.js";
import { getSocket, saveResume } from "./net.js";

const EMOTES = ["👍", "🔥", "😂", "😭"];
const GOLD = "#FFC14D";
const BLUE = "#3EC8FF";
const QUEEN = "#FF3B5C";

function makeSfx() {
  let ac = null;
  const state = { muted: false };
  const ctx = () => {
    if (state.muted) return null;
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
    state,
  };
}

// mode: 'ai' | 'pvp' | 'online'
// online: { playerIndex, startAt } (socket via getSocket())
// The match screen is the neon arena — board themes do not restyle it.
export default function RelayGame({ mode, online, onExit }) {
  const players = [GOLD, BLUE];
  const C = {
    board: "#07080f", boardDeep: "#05060c", panel: "rgba(10,14,26,0.72)", line: "rgba(255,255,255,0.08)",
    copper: GOLD, hot: "#FFF6D8", neutral: "#8FD4FF", text: "#E8F1FF", dim: "#8EA0C0",
  };
  const rootRef = useRef(null);
  const [w, setW] = useState(() => document.documentElement.clientWidth || window.innerWidth);
  const [h, setH] = useState(() => window.visualViewport?.height || window.innerHeight);
  useEffect(() => {
    const measure = () => {
      const el = rootRef.current;
      setW(el ? el.clientWidth : document.documentElement.clientWidth || window.innerWidth);
      setH(window.visualViewport?.height || window.innerHeight);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);
  // Header, score row, prompt, the floor mirror and the dock sit around the board.
  const chrome = 268;
  const size = Math.max(200, Math.min(440, w - 16, Math.floor((h - chrome) / 1.26)));
  const engineSize = mode === "online" ? ONLINE_BOARD : size;

  const [turn, setTurn] = useState(0);
  const [scores, setScores] = useState([0, 0]);
  const [winner, setWinner] = useState(null);
  const [callout, setCallout] = useState(null);
  const [waitingStart, setWaitingStart] = useState(mode === "online" && !online?.resumed);
  const [oppLeft, setOppLeft] = useState(false);
  const [rematchState, setRematchState] = useState(null); // 'sent' | 'received'
  const [emoteFx, setEmoteFx] = useState(null);
  const [portsIn, setPortsIn] = useState(null); // seconds left in an active port-shift warning, or null
  const [turnSecLeft, setTurnSecLeft] = useState(TURN_SECONDS);
  const [turnToken, setTurnToken] = useState(0); // bumped whenever the shot clock resets, to restart its border animation
  const [linkNote, setLinkNote] = useState(null);
  const [streak, setStreak] = useState(0);
  const [sheet, setSheet] = useState(null);
  const [muted, setMuted] = useState(false);

  const nameRefs = useRef([]);
  const canvasRef = useRef(null);
  const reflectRef = useRef(null);
  const [flies, setFlies] = useState([]);
  const [nameFlash, setNameFlash] = useState([0, 0]);
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

  const spawnScoreFly = (player, pts, x, y, color) => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    const nameEl = nameRefs.current[player];
    const g = G.current;
    if (!canvas || !root || !nameEl || !g || x == null || y == null) return;
    const cr = canvas.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const nr = nameEl.getBoundingClientRect();
    const scale = cr.width / g.S;
    const fromX = cr.left - rr.left + x * scale;
    const fromY = cr.top - rr.top + y * scale;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setFlies((list) => [...list, {
      id, pts, color,
      x: fromX, y: fromY,
      dx: nr.left - rr.left + nr.width / 2 - fromX,
      dy: nr.top - rr.top + nr.height / 2 - fromY,
    }]);
    setTimeout(() => {
      setFlies((list) => list.filter((f) => f.id !== id));
      setNameFlash((flash) => {
        const next = [...flash];
        next[player] = (next[player] || 0) + 1;
        return next;
      });
    }, 680);
  };

  // ---------------- init ----------------
  useEffect(() => {
    G.current = createGame(engineSize);
    if (mode === "online" && online?.snapshot) applySync(G.current, online.snapshot);
    if (!sfx.current) sfx.current = makeSfx();
    arcs.current = [];
    rejects.current = [];
    setScores([...(G.current.scores)]); setTurn(G.current.turn); setWinner(G.current.winner);
    setTurnSecLeft(Math.ceil(G.current.turnTimeLeft / 60)); setTurnToken(0);
    setStreak(G.current.streak || 0);

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
          ? me === 0 ? "YOU SHOOT FIRST" : "VOLT SHOOTS FIRST"
          : "YOU SHOOT FIRST",
        players[mode === "online" ? me : 0], 1600);
    };

    if (mode === "online" && !online?.resumed) {
      const delay = Math.max(0, online.startAt - Date.now());
      const t = setTimeout(beginMatch, delay);
      return () => clearTimeout(t);
    }
    if (online?.resumed) {
      setWaitingStart(false);
      return;
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
    const applyServer = (snap) => {
      const g = G.current;
      if (!g || !snap) return;
      applySync(g, snap);
      setScores([...g.scores]); setTurn(g.turn); setStreak(g.streak || 0);
      setTurnSecLeft(Math.ceil((g.turnTimeLeft || 0) / 60));
      if (g.winner !== null) setWinner(g.winner);
    };
    const onState = ({ kind, snap, reason }) => {
      const g = G.current;
      if (!g || !snap) return;
      const turnChanged = snap.turn !== g.turn;
      const matchEnded = snap.winner != null && g.winner == null;
      // keep animating a local shot, but never ignore a server timeout or ending
      if (kind === "tick" && g.phase === "resolve" && !turnChanged && !matchEnded) return;
      const prevTurn = g.turn;
      const prevScore = `${g.scores[0]}:${g.scores[1]}`;
      applyServer(snap);
      if (reason) say(reason, "#FF6A6A", 1200);
      const sameScore = `${snap.scores?.[0]}:${snap.scores?.[1]}` === prevScore;
      if (kind === "tick" && snap.winner == null && snap.turn !== prevTurn && sameScore) {
        drag.current = null;
        sfx.current?.reject();
        setTurnToken((t) => t + 1);
        say("TIME'S UP — TURN PASSED", "#FF6A6A", 1500);
      }
    };
    const onDisc = () => setLinkNote("OPPONENT RECONNECTING…");
    const onBack = () => setLinkNote(null);
    const onLeft = () => { saveResume(null); setLinkNote(null); setOppLeft(true); setWinner(me); sfx.current?.win(); };
    const onRematchReq = () => setRematchState("received");
    const onEmote = ({ emote }) => {
      setEmoteFx({ emote, side: 1 - me, key: Date.now() });
      setTimeout(() => setEmoteFx(null), 1800);
    };
    socket.on("opponentFlick", onFlick);
    socket.on("syncState", applyServer);
    socket.on("state", onState);
    socket.on("opponentLeft", onLeft);
    socket.on("opponentDisconnected", onDisc);
    socket.on("opponentReconnected", onBack);
    socket.on("rematchRequested", onRematchReq);
    socket.on("emote", onEmote);
    return () => {
      socket.off("opponentFlick", onFlick);
      socket.off("syncState", applyServer);
      socket.off("state", onState);
      socket.off("opponentLeft", onLeft);
      socket.off("opponentDisconnected", onDisc);
      socket.off("opponentReconnected", onBack);
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
      else if (e.t === "pot" || e.t === "queenPot") {
        if (e.t === "pot") sfx.current?.pot();
        else sfx.current?.win();
        setScores([...g.scores]);
        spawnScoreFly(e.player, e.pts || 1, e.x, e.y, e.t === "queenPot" ? QUEEN : players[e.player]);
        if (e.t === "queenPot") say(`QUEEN! +${e.pts || QUEEN_POINTS}`, QUEEN, 1800);
      }
      else if (e.t === "poison") {
        sfx.current?.poison(); setScores([...g.scores]);
        spawnScoreFly(e.player, e.pts || 1, e.x, e.y, players[e.player]);
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
      else if (e.t === "queenShift") say("QUEEN RESET", QUEEN, 1200);
      else if (e.t === "turnTimeout") {
        drag.current = null;
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
    setStreak(g.streak || 0);
  };

  // ---------------- fixed-timestep loop + render ----------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = engineSize * dpr;
    canvas.height = engineSize * dpr;
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
        // online: server sweep is the shot clock. stepping it here too let a
        // local timeout pass the turn, then the next snapshot put it back.
        stepGame(g, ev, { clock: mode !== "online" });
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
      paintFloor(canvas);
      const { pending } = portRotateInfo(g);
      const nextPortsIn = pending ? Math.ceil(pending.framesLeft / 60) : null;
      if (nextPortsIn !== lastPortsIn) { lastPortsIn = nextPortsIn; setPortsIn(nextPortsIn); }
      const nextTurnSec = g.phase === "aim" ? Math.ceil(g.turnTimeLeft / 60) : TURN_SECONDS;
      if (nextTurnSec !== lastTurnSec) { lastTurnSec = nextTurnSec; setTurnSecLeft(nextTurnSec); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);

    function paintFloor(source) {
      const reflect = reflectRef.current;
      if (!reflect) return;
      const rh = Math.round(engineSize * 0.26);
      const rw = source.width;
      const rhh = Math.max(1, Math.round(rh * dpr));
      const crop = Math.round(engineSize * 0.028 * dpr);
      if (reflect.width !== rw || reflect.height !== rhh) {
        reflect.width = rw;
        reflect.height = rhh;
      }
      const rctx = reflect.getContext("2d");
      rctx.setTransform(1, 0, 0, 1, 0, 0);
      rctx.clearRect(0, 0, rw, rhh);
      rctx.save();
      rctx.translate(0, rhh);
      rctx.scale(1, -1);
      rctx.drawImage(source, 0, Math.max(0, source.height - rhh - crop), rw, rhh, 0, 0, rw, rhh);
      rctx.restore();
      rctx.globalCompositeOperation = "destination-in";
      const fade = rctx.createLinearGradient(0, 0, 0, rhh);
      fade.addColorStop(0, "rgba(0,0,0,0.88)");
      fade.addColorStop(0.16, "rgba(0,0,0,0.55)");
      fade.addColorStop(0.42, "rgba(0,0,0,0.22)");
      fade.addColorStop(0.72, "rgba(0,0,0,0.05)");
      fade.addColorStop(1, "rgba(0,0,0,0)");
      rctx.fillStyle = fade;
      rctx.fillRect(0, 0, rw, rhh);
      rctx.globalCompositeOperation = "source-over";
      const glow = rctx.createRadialGradient(rw / 2, rhh * 0.02, rw * 0.04, rw / 2, rhh * 0.55, rw * 0.55);
      glow.addColorStop(0, "rgba(255, 196, 90, 0.42)");
      glow.addColorStop(0.38, "rgba(255, 150, 40, 0.16)");
      glow.addColorStop(0.7, "rgba(40, 120, 255, 0.07)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      rctx.fillStyle = glow;
      rctx.fillRect(0, 0, rw, rhh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const render = (ctx, g, pulse) => {
    const { S, R, pad } = g;
    ctx.clearRect(0, 0, S, S);
    drawNeonBoard(ctx, g, pulse);

    // ports — only the "live" one (getLivePorts) accepts a pot; it's
    // whichever pocket is currently hardest to reach, and it flickers only
    // in the last moment of an active shift warning
    const liveGates = getLivePorts(g);
    const { pending } = portRotateInfo(g);
    const flicker = pending && pending.framesLeft < 45 && Math.floor(pending.framesLeft / 4) % 2 === 0;
    g.pockets.forEach((pk, pi) => {
      const isLive = liveGates.includes(pi) && !flicker;
      const sideBlue = pi === 1 || pi === 3;
      const glow = isLive ? "#FFF1C2" : sideBlue ? BLUE : GOLD;
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, g.pocketR, 0, Math.PI * 2);
      const hole = ctx.createRadialGradient(pk.x, pk.y, 2, pk.x, pk.y, g.pocketR);
      hole.addColorStop(0, "#010206");
      hole.addColorStop(0.72, "#070b14");
      hole.addColorStop(1, "rgba(7,11,20,0)");
      ctx.fillStyle = hole;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, g.pocketR * 0.86, 0, Math.PI * 2);
      ctx.strokeStyle = glow;
      ctx.globalAlpha = isLive ? 0.28 : 0.14;
      ctx.lineWidth = isLive ? 7 : 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, g.pocketR * 0.78, 0, Math.PI * 2);
      ctx.strokeStyle = glow;
      ctx.lineWidth = isLive ? 2.4 : 1.5;
      ctx.globalAlpha = isLive ? 1 : 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (isLive) {
        ctx.beginPath();
        ctx.arc(pk.x, pk.y, g.pocketR * (0.42 + 0.08 * Math.sin(pulse * 3)), 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,241,194,0.45)";
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
            if (Math.hypot(o.x - sx, o.y - sy) < R * 2) {
              hit = { x: sx, y: sy, ox: o.x, oy: o.y, svx, svy, queen: !!o.isQueen };
              break;
            }
          }
          if (k % 2 === 0) ctx.lineTo(sx, sy);
          if (hit || Math.hypot(svx, svy) < 0.15) break;
        }
        ctx.strokeStyle = doom ? "rgba(255,80,80,0.9)" : reject ? "rgba(255,160,46,0.85)" : `${players[g.turn]}AA`;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 8]);
        ctx.lineDashOffset = -pulse * 14;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
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
          const dx = hit.ox - hit.x, dy = hit.oy - hit.y;
          const dist = Math.hypot(dx, dy) || 1;
          const hx = dx / dist, hy = dy / dist;
          const along = hit.svx * hx + hit.svy * hy;
          const imp = Math.max(0, along) * 0.93;
          const aimArrow = (x, y, vx, vy, color, len) => {
            const sp = Math.hypot(vx, vy);
            if (sp < 0.04) return;
            const ux = vx / sp, uy = vy / sp;
            const x2 = x + ux * len, y2 = y + uy * len;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 4]);
            ctx.lineDashOffset = -pulse * 10;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineDashOffset = 0;
            const px = -uy, py = ux;
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - ux * 8 + px * 4.5, y2 - uy * 8 + py * 4.5);
            ctx.lineTo(x2 - ux * 8 - px * 4.5, y2 - uy * 8 - py * 4.5);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
          };
          ctx.beginPath();
          ctx.arc(hit.x, hit.y, R * 0.55, 0, Math.PI * 2);
          ctx.strokeStyle = C.hot;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          aimArrow(hit.ox, hit.oy, hx * imp, hy * imp, hit.queen ? QUEEN : "#F4FFF0", R * 2.6);
          aimArrow(hit.x, hit.y, hit.svx - hx * imp, hit.svy - hy * imp, `${players[g.turn]}CC`, R * 1.7);
        }
        const breathe = 0.5 + 0.5 * Math.sin(pulse * 5);
        const gap = R + 8 + breathe * 3;
        const stickLen = R * 2.4 + pow * 0.9;
        const back = ang + Math.PI;
        const tipX = pk.x + Math.cos(back) * gap;
        const tipY = pk.y + Math.sin(back) * gap;
        const buttX = pk.x + Math.cos(back) * (gap + stickLen);
        const buttY = pk.y + Math.sin(back) * (gap + stickLen);
        ctx.save();
        ctx.lineCap = "round";
        ctx.shadowColor = players[g.turn];
        ctx.shadowBlur = 16 + breathe * 8;
        const shaft = ctx.createLinearGradient(buttX, buttY, tipX, tipY);
        shaft.addColorStop(0, "rgba(255,255,255,0)");
        shaft.addColorStop(0.4, players[g.turn]);
        shaft.addColorStop(1, "#FFFFFF");
        ctx.beginPath();
        ctx.moveTo(buttX, buttY);
        ctx.lineTo(tipX, tipY);
        ctx.strokeStyle = shaft;
        ctx.lineWidth = Math.max(3.2, R * 0.26);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(tipX, tipY, Math.max(2.2, R * 0.16), 0, Math.PI * 2);
        ctx.fillStyle = "#FFFFFF";
        ctx.fill();
        ctx.shadowBlur = 0;
        const nx = -Math.sin(ang);
        const ny = Math.cos(ang);
        for (let c = 0; c < 2; c++) {
          const u = ((pulse * 0.18 + c * 0.5) % 1);
          const cx = pk.x + Math.cos(ang) * (R * 1.6 + u * pow * 0.55);
          const cy = pk.y + Math.sin(ang) * (R * 1.6 + u * pow * 0.55);
          ctx.globalAlpha = 0.35 + 0.45 * (1 - u);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(ang) * 7, cy + Math.sin(ang) * 7);
          ctx.lineTo(cx + nx * 5, cy + ny * 5);
          ctx.lineTo(cx - nx * 5, cy - ny * 5);
          ctx.closePath();
          ctx.fillStyle = players[g.turn];
          ctx.fill();
        }
        ctx.restore();
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

    // pucks — neon rings, with a motion trail while they travel
    g.pucks.forEach((p, i) => {
      if (!p.alive) return;
      const scale = p.sink ? p.sink.s : 1;
      const rad = R * scale;
      const isQueenVisible = p.isQueen && !p.striker;
      const col = p.striker ? players[g.turn] : isQueenVisible ? QUEEN : p.charge !== null ? players[p.charge] : C.neutral;
      const hot = p.striker || p.charge !== null || isQueenVisible;
      const spd = Math.hypot(p.vx, p.vy);
      if (spd > 0.7 && !p.sink) {
        for (let k = 6; k >= 1; k--) {
          ctx.beginPath();
          ctx.arc(p.x - p.vx * k * 0.85, p.y - p.vy * k * 0.85, rad * (1 - k * 0.07), 0, Math.PI * 2);
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.22 * (1 - k / 7);
          ctx.lineWidth = Math.max(1.5, rad * 0.22);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      if (isQueenVisible) {
        const qg = ctx.createRadialGradient(-rad * 0.2, -rad * 0.25, 1, 0, 0, rad);
        qg.addColorStop(0, "#FFD0DA");
        qg.addColorStop(0.45, QUEEN);
        qg.addColorStop(1, "#8E1230");
        ctx.beginPath();
        ctx.arc(0, 0, rad * 1.15, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 59, 92, 0.22)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.fillStyle = qg;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#FFE4EA";
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, rad * 0.82, 0, Math.PI * 2);
        ctx.strokeStyle = col;
        ctx.globalAlpha = hot ? 0.22 : 0.12;
        ctx.lineWidth = Math.max(5, rad * 0.72);
        ctx.stroke();
        ctx.globalAlpha = hot ? 1 : 0.92;
        ctx.lineWidth = Math.max(2.4, rad * 0.34);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(0, 0, rad * 0.46, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(4, 8, 18, 0.92)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(-rad * 0.22, -rad * 0.28, rad * 0.13, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fill();
        if (p.striker) {
          ctx.beginPath();
          ctx.arc(0, 0, rad * 0.2, 0, Math.PI * 2);
          ctx.fillStyle = "#FFFFFF";
          ctx.fill();
        }
      }
      if (drag.current && drag.current.idx === i) {
        const ring = rad + 5 + Math.sin(pulse * 5) * 2.2;
        ctx.beginPath();
        ctx.arc(0, 0, ring, 0, Math.PI * 2);
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(pulse * 5));
        ctx.lineWidth = 1.6;
        ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      ctx.shadowBlur = 0;
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

  function drawNeonBoard(ctx, g, pulse) {
    const { S, R, cx, cy } = g;
    ctx.fillStyle = "#05070e";
    ctx.fillRect(0, 0, S, S);

    const m = S * 0.045;
    const glass = ctx.createLinearGradient(0, 0, S, S);
    glass.addColorStop(0, "#10182e");
    glass.addColorStop(0.5, "#070b16");
    glass.addColorStop(1, "#0c1424");
    rr(ctx, m, m, S - m * 2, S - m * 2, S * 0.07);
    ctx.fillStyle = glass;
    ctx.fill();

    ctx.save();
    rr(ctx, m + 6, m + 6, S - (m + 6) * 2, S - (m + 6) * 2, S * 0.055);
    ctx.clip();
    ctx.strokeStyle = "rgba(90, 170, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const cells = 6;
    for (let i = 1; i < cells; i++) {
      const t = m + ((S - m * 2) * i) / cells;
      ctx.moveTo(m, t); ctx.lineTo(S - m, t);
      ctx.moveTo(t, m); ctx.lineTo(t, S - m);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 196, 80, 0.12)";
    ctx.beginPath();
    ctx.moveTo(m, m); ctx.lineTo(S - m, S - m);
    ctx.moveTo(S - m, m); ctx.lineTo(m, S - m);
    ctx.moveTo(cx, m); ctx.lineTo(cx, S - m);
    ctx.moveTo(m, cy); ctx.lineTo(S - m, cy);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 196, 90, 0.28)";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 3.15 + Math.sin(pulse * 2) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const frame = ctx.createLinearGradient(0, 0, S, S);
    frame.addColorStop(0, "#FFB020");
    frame.addColorStop(0.42, "#FFE7A8");
    frame.addColorStop(0.58, "#8AD8FF");
    frame.addColorStop(1, "#2F8CFF");
    ctx.save();
    ctx.lineWidth = Math.max(14, S * 0.04);
    ctx.strokeStyle = "rgba(255, 176, 48, 0.16)";
    rr(ctx, m, m, S - m * 2, S - m * 2, S * 0.07);
    ctx.stroke();
    ctx.lineWidth = Math.max(6, S * 0.018);
    ctx.strokeStyle = frame;
    rr(ctx, m, m, S - m * 2, S - m * 2, S * 0.07);
    ctx.stroke();
    ctx.restore();

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    rr(ctx, m + 8, m + 8, S - (m + 8) * 2, S - (m + 8) * 2, S * 0.05);
    ctx.stroke();
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
    const scale = rect.width ? (G.current?.S || rect.width) / rect.width : 1;
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
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
  const statusLine = linkNote ? linkNote
    : winner !== null ? "MATCH OVER"
    : waitingStart ? "SYNCING…"
    : mode === "ai" && turn === 1 ? "AI IS ROUTING…"
    : mode === "online" ? (turn === me ? "YOUR SHOT — FLICK ANY PUCK" : "OPPONENT IS AIMING…")
    : `${PNAME[turn]} — FLICK ANY PUCK`;
  const pipOn = streak > 0 ? ((streak - 1) % 3) + 1 : 0;
  const sideLabel = (p) => (mode === "ai" && p === 1 ? "AI" : PNAME[p]);

  return (
    <div ref={rootRef} className="cyber">
      <style>{`
        @keyframes rlInfuse { 0%{transform:scale(1)} 40%{transform:scale(1.28)} 100%{transform:scale(1)} }
        @keyframes rlScore {
          0%{opacity:0; transform:translate(-50%,-50%) scale(.4)}
          16%{opacity:1; transform:translate(-50%,-50%) scale(1.25)}
          100%{opacity:0; transform:translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(.15)}
        }
        @keyframes rlPulse { 0%,100%{opacity:.55} 50%{opacity:1} }
        @keyframes rlCall { 0%{opacity:0} 15%{opacity:1} 80%{opacity:1} 100%{opacity:0} }
        .callout {
          position: absolute; top: 11%; left: 10%; right: 10%; text-align: center; pointer-events: none;
          font-family: 'Orbitron', sans-serif; font-size: 12px; letter-spacing: 1.5px; line-height: 1.35;
          padding: 6px 8px; border-radius: 12px; background: rgba(5,8,16,.45);
        }
        @keyframes rlEmote {
          0%{opacity:0; transform:translateX(-50%) translateY(8px) scale(.6)}
          20%{opacity:1; transform:translateX(-50%) translateY(0) scale(1.15)}
          35%{transform:translateX(-50%) translateY(0) scale(1)}
          75%{opacity:1; transform:translateX(-50%) translateY(-3px) scale(1)}
          100%{opacity:0; transform:translateX(-50%) translateY(-10px) scale(.92)}
        }
        .cyber {
          position: relative; min-height: 100dvh; width: 100%; box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
          padding: max(12px, env(safe-area-inset-top)) 14px max(16px, env(safe-area-inset-bottom));
          color: #E8F1FF; user-select: none; -webkit-user-select: none;
          font-family: 'Rajdhani', 'Space Mono', sans-serif;
          background:
            radial-gradient(90% 32% at 18% -8%, rgba(255,176,48,.34), transparent 58%),
            radial-gradient(70% 28% at 92% 0%, rgba(46,140,255,.22), transparent 52%),
            linear-gradient(180deg, #10141f 0%, #07080f 42%, #05060c 100%);
        }
        .topbar { width: min(520px, 100%); display: flex; align-items: center; justify-content: space-between; position: relative; z-index: 4; }
        .brand { display: flex; align-items: center; gap: 10px; }
        .brand h1 { margin: 0; font-family: 'Orbitron', 'Audiowide', sans-serif; font-size: clamp(16px, 4.6vw, 22px); letter-spacing: 1px; font-weight: 700; line-height: 1; color: #F4F7FF; }
        .brand h1 span { color: #FFC14D; }
        .tag { margin-top: 3px; font-size: 9px; letter-spacing: 2.2px; color: #9aa6c2; font-weight: 600; }
        .iconrow { display: flex; gap: 8px; }
        .iconbtn {
          width: 42px; height: 42px; border-radius: 14px; border: 1px solid rgba(255,255,255,.08);
          background: rgba(14,18,32,.82); color: #d5dbea; display: grid; place-items: center; cursor: pointer;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 8px 16px rgba(0,0,0,.35);
        }
        .iconbtn.on { color: #FFC14D; border-color: rgba(255,193,77,.55); box-shadow: 0 0 16px rgba(255,193,77,.28); }
        .sheet {
          position: absolute; top: calc(100% + 8px); right: 0; z-index: 6; width: min(260px, 78vw);
          padding: 12px 14px; border-radius: 16px; text-align: left;
          background: rgba(8,12,22,.86); border: 1px solid rgba(255,255,255,.1);
          backdrop-filter: blur(16px); box-shadow: 0 18px 40px rgba(0,0,0,.5); color: #E8F1FF;
        }
        .sheet b { display: block; font-family: 'Orbitron', sans-serif; font-size: 10px; letter-spacing: 2px; color: #FFC14D; margin-bottom: 8px; }
        .sheet p { margin: 0 0 6px; font-size: 14px; letter-spacing: .3px; }
        .sheet button { font-family: 'Orbitron', sans-serif; font-size: 11px; letter-spacing: 1px; color: #FFC14D; background: transparent; border: 1px solid rgba(255,193,77,.45); border-radius: 10px; padding: 8px 10px; cursor: pointer; }
        .scoreline { width: min(520px, 100%); margin-top: 14px; display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
        .panel {
          position: relative; min-height: 78px; border-radius: 18px; box-sizing: border-box;
          display: flex; align-items: center; gap: 8px; padding: 8px 12px 8px 10px;
          background: rgba(8,12,22,.62); backdrop-filter: blur(10px);
        }
        .panel.volt {
          border: 1.5px solid rgba(255,193,77,.55);
          box-shadow: inset 0 0 14px rgba(255,176,48,.05);
        }
        .panel.ai {
          border: 1.5px solid rgba(62,200,255,.45);
          box-shadow: inset 0 0 14px rgba(62,180,255,.05);
        }
        .panel.live.volt {
          border-color: rgba(255,193,77,.98);
          box-shadow: 0 0 18px rgba(255,176,48,.45), inset 0 0 16px rgba(255,176,48,.1);
        }
        .panel.live.ai {
          border-color: rgba(90,214,255,.98);
          box-shadow: 0 0 18px rgba(62,180,255,.45), inset 0 0 16px rgba(62,180,255,.1);
        }
        .mark { flex: 0 0 28px; width: 28px; height: 28px; }
        .panel.volt .mark { filter: drop-shadow(0 0 6px rgba(255,193,77,.65)); }
        .panel.ai .mark { filter: drop-shadow(0 0 6px rgba(62,200,255,.55)); }
        .id { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
        .lbl { font-family: 'Orbitron', sans-serif; font-size: 11px; letter-spacing: 2px; line-height: 1; }
        .panel.volt .lbl { color: #FFC14D; text-shadow: 0 0 10px rgba(255,193,77,.45); }
        .panel.ai .lbl { color: #9BE7FF; text-shadow: 0 0 8px rgba(62,200,255,.35); }
        .chip {
          min-width: 46px; height: 36px; padding: 0 10px; border-radius: 12px; box-sizing: border-box;
          display: grid; place-items: center;
          font-family: 'Rajdhani', sans-serif; font-size: 26px; font-weight: 700; line-height: 1;
          background: rgba(6,16,28,.72);
        }
        .panel.volt .chip {
          color: #FFC14D; border: 1.5px solid rgba(255,193,77,.9);
          box-shadow: 0 0 12px rgba(255,176,48,.28), inset 0 0 10px rgba(255,193,77,.12);
        }
        .panel.ai .chip {
          color: #7FE3FF; border: 1.5px solid rgba(127,227,255,.85);
          box-shadow: 0 0 12px rgba(62,200,255,.28), inset 0 0 10px rgba(62,200,255,.12);
        }
        .you { display: block; font-style: normal; font-size: 8px; letter-spacing: 1.4px; opacity: .75; }
        .pips { display: flex; gap: 6px; }
        .pip {
          width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center;
          font-family: 'Orbitron', sans-serif; font-size: 12px; color: #8ea0c0;
          background: rgba(12,16,28,.9); border: 1px solid rgba(255,255,255,.1);
        }
        .pip.on { color: #FFC14D; border-color: rgba(255,193,77,.95); box-shadow: 0 0 12px rgba(255,193,77,.45); background: rgba(42,30,8,.8); }
        .prompt {
          margin: 8px 0 8px; min-height: 16px; font-family: 'Orbitron', sans-serif;
          font-size: 10px; letter-spacing: 2.2px; color: #FFC14D; text-align: center;
          text-shadow: 0 0 10px rgba(255,193,77,.35);
        }
        .ports { height: 14px; margin-top: -4px; margin-bottom: 4px; font-size: 10px; letter-spacing: 1.6px; color: #FF6A6A; font-family: 'Orbitron', sans-serif; }
        .stage { position: relative; }
        .reflect { display: block; margin: -12px auto 8px; pointer-events: none; }
        .dock { width: min(520px, 100%); display: grid; grid-template-columns: 76px 1fr 76px; gap: 12px; align-items: end; }
        .dock button { cursor: pointer; color: #FFC14D; background: rgba(10,14,24,.78); }
        .dock .sq {
          height: 68px; border-radius: 16px; border: 1px solid rgba(255,193,77,.35);
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
          font-family: 'Orbitron', sans-serif; font-size: 8px; letter-spacing: 1.4px;
          box-shadow: inset 0 0 12px rgba(255,193,77,.05);
        }
        .dock .wide {
          height: 54px; border-radius: 18px; border: 1.5px solid rgba(255,193,77,.8);
          display: flex; align-items: center; justify-content: center; gap: 8px;
          font-family: 'Orbitron', sans-serif; font-size: clamp(12px, 3.4vw, 15px); letter-spacing: 3px;
          box-shadow: 0 0 22px rgba(255,176,48,.32), inset 0 0 14px rgba(255,193,77,.08);
        }
        .dock button:disabled { opacity: .35; cursor: default; }
        .dock .sq.on { border-color: rgba(255,193,77,.9); box-shadow: 0 0 16px rgba(255,176,48,.35); }
        .statov {
          position: fixed; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center;
          background: rgba(4,6,12,.62); backdrop-filter: blur(6px); padding: 20px;
        }
        .statcard {
          width: min(300px, 100%); border-radius: 18px; padding: 16px 16px 14px; text-align: left;
          background: rgba(8,12,22,.92); border: 1px solid rgba(255,193,77,.35);
          box-shadow: 0 0 28px rgba(255,176,48,.18), 0 18px 40px rgba(0,0,0,.5);
        }
        .statcard b { display: block; font-family: 'Orbitron', sans-serif; font-size: 11px; letter-spacing: 3px; color: #FFC14D; margin-bottom: 10px; }
        .statrow { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 6px 0; border-top: 1px solid rgba(255,255,255,.08); font-size: 14px; letter-spacing: .4px; }
        .statrow span { color: #8EA0C0; }
        .statrow strong { font-family: 'Rajdhani', sans-serif; font-size: 22px; font-weight: 700; color: #F4F7FF; }
        .statcard button {
          margin-top: 12px; width: 100%; cursor: pointer;
          font-family: 'Orbitron', sans-serif; font-size: 11px; letter-spacing: 2px; color: #FFC14D;
          background: transparent; border: 1px solid rgba(255,193,77,.5); border-radius: 12px; padding: 10px;
        }
        .emotes { display: flex; gap: 6px; margin-top: 8px; }
        .emotes button { font-size: 16px; padding: 4px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,.12); background: transparent; cursor: pointer; }
        @media (prefers-reduced-motion: reduce){ *{animation:none !important} }
      `}</style>

      {flies.map((fx) => (
        <div
          key={fx.id}
          style={{
            position: "absolute", left: fx.x, top: fx.y, zIndex: 40, pointerEvents: "none",
            color: fx.color, fontFamily: "'Orbitron', sans-serif", fontSize: 22, letterSpacing: 1,
            textShadow: `0 0 16px ${fx.color}`,
            animation: "rlScore 680ms cubic-bezier(.22,.8,.2,1) forwards",
            "--dx": `${fx.dx}px`, "--dy": `${fx.dy}px`,
          }}
        >+{fx.pts}</div>
      ))}

      <header className="topbar">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path fill="#FFC14D" d="M13 1.5 3.5 13.5h7.2L9.2 22.5 20.5 9.2h-7.1L13 1.5z"/></svg>
          <div>
            <h1>RELAY<span>PUCK</span></h1>
            <div className="tag">FLICK · PASS · CONTROL</div>
          </div>
        </div>
        <div className="iconrow">
          <button type="button" className={sheet === "stats" ? "iconbtn on" : "iconbtn"} aria-label="Match stats" onClick={() => setSheet((s) => s === "stats" ? null : "stats")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 19V10M12 19V5M19 19v-7"/></svg>
          </button>
          <button type="button" className={sheet === "trophy" ? "iconbtn on" : "iconbtn"} aria-label="Scoring" onClick={() => setSheet((s) => s === "trophy" ? null : "trophy")} style={{ color: "#FFC14D" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 4h8v3a4 4 0 0 1-8 0V4z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 11v3M9 20h6M10 17h4v3h-4z"/></svg>
          </button>
          <button type="button" className={sheet === "gear" ? "iconbtn on" : "iconbtn"} aria-label="Settings" onClick={() => setSheet((s) => s === "gear" ? null : "gear")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/></svg>
          </button>
        </div>
        {sheet && sheet !== "stats" && (
          <div className="sheet" role="dialog">
            {sheet === "trophy" && (
              <>
                <b>SCORING</b>
                <p>Charged puck in the live port +1</p>
                <p>Queen +5</p>
                <p>3 in a row +1 bonus</p>
                <p>Your striker sunk gives the rival +1</p>
              </>
            )}
            {sheet === "gear" && (
              <>
                <b>ARENA</b>
                <button type="button" onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  if (sfx.current) sfx.current.state.muted = next;
                }}>{muted ? "SOUND OFF" : "SOUND ON"}</button>
                {mode === "online" && (
                  <div className="emotes">
                    {EMOTES.map((em) => (
                      <button key={em} type="button" onClick={() => {
                        getSocket().emit("emote", { emote: em });
                        setEmoteFx({ emote: em, side: me, key: Date.now() });
                        setTimeout(() => setEmoteFx(null), 1800);
                      }}>{em}</button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </header>

      <div className="scoreline">
        <div className={turn === 0 && winner === null ? "panel volt live" : "panel volt"}>
          <svg className="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#FFC14D" d="M13 1.5 3.5 13.5h7.2L9.2 22.5 20.5 9.2h-7.1L13 1.5z"/></svg>
          <div className="id">
            <div ref={(el) => { nameRefs.current[0] = el; }} key={`name-0-${nameFlash[0] || 0}`} className="lbl" style={{ animation: nameFlash[0] ? "rlInfuse 420ms ease-out" : undefined }}>{sideLabel(0)}</div>
            {mode === "online" && me === 0 && <i className="you">YOU</i>}
            <div className="chip">{scores[0]}</div>
          </div>
          {emoteFx && emoteFx.side === 0 && (
            <div key={emoteFx.key} style={{ position: "absolute", top: -22, left: "50%", transform: "translateX(-50%)", fontSize: 24, animation: "rlEmote 1.8s ease-out forwards", pointerEvents: "none" }}>{emoteFx.emote}</div>
          )}
        </div>
        <div className="pips" aria-label="Relay chain">
          {[1, 2, 3].map((n) => <div key={n} className={pipOn === n ? "pip on" : "pip"}>{n}</div>)}
        </div>
        <div className={turn === 1 && winner === null ? "panel ai live" : "panel ai"}>
          {mode === "ai" ? (
            <svg className="mark" viewBox="0 0 24 24" fill="none" stroke="#7FE3FF" strokeWidth="1.6" aria-hidden="true">
              <rect x="4" y="8" width="16" height="11" rx="4"/>
              <circle cx="9" cy="13.5" r="1.2" fill="#7FE3FF"/>
              <circle cx="15" cy="13.5" r="1.2" fill="#7FE3FF"/>
              <path d="M12 8V4.5M9 4.5h6"/>
            </svg>
          ) : (
            <svg className="mark" viewBox="0 0 24 24" fill="none" stroke="#7FE3FF" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="8" r="3.2"/>
              <path d="M5.5 19.2c1.2-3.2 3.5-4.7 6.5-4.7s5.3 1.5 6.5 4.7"/>
            </svg>
          )}
          <div className="id">
            <div ref={(el) => { nameRefs.current[1] = el; }} key={`name-1-${nameFlash[1] || 0}`} className="lbl" style={{ animation: nameFlash[1] ? "rlInfuse 420ms ease-out" : undefined }}>{sideLabel(1)}</div>
            {mode === "online" && me === 1 && <i className="you">YOU</i>}
            <div className="chip">{scores[1]}</div>
          </div>
          {emoteFx && emoteFx.side === 1 && (
            <div key={emoteFx.key} style={{ position: "absolute", top: -22, left: "50%", transform: "translateX(-50%)", fontSize: 24, animation: "rlEmote 1.8s ease-out forwards", pointerEvents: "none" }}>{emoteFx.emote}</div>
          )}
        </div>
      </div>

      <div className="prompt" style={{ animation: "rlPulse 1.6s infinite", color: linkNote ? "#FF6A6A" : turn === 1 ? BLUE : GOLD }}>{statusLine}</div>
      <div className="ports" style={{ visibility: winner === null && !waitingStart && portsIn !== null ? "visible" : "hidden", animation: portsIn !== null && portsIn <= 3 ? "rlPulse 0.6s infinite" : "none" }}>
        PORTS SHIFT {portsIn ?? 0}s
      </div>

      <div className="stage">
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size, touchAction: "none", cursor: "crosshair", display: "block", borderRadius: 28 }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {callout && (
          <div className="callout" style={{ color: callout.col, textShadow: `0 0 12px ${callout.col}`, animation: "rlCall 1.5s ease-out forwards" }}>
            {callout.text}
          </div>
        )}
      </div>
      <canvas
        ref={reflectRef}
        className="reflect"
        aria-hidden="true"
        style={{ width: size, height: Math.round(size * 0.26) }}
      />

      <div className="dock">
        <button type="button" className={sheet === "stats" ? "sq on" : "sq"} onClick={() => setSheet((s) => s === "stats" ? null : "stats")} aria-label="Match stats">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFC14D" strokeWidth="1.8"><path d="M5 19V10M12 19V5M19 19v-7"/></svg>
          STATS
        </button>
        <button type="button" className="wide" onClick={() => { if (mode !== "online") onExit("restart"); }} disabled={mode === "online"}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFC14D" strokeWidth="1.8"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/></svg>
          RESTART
        </button>
        <button type="button" className="sq" onClick={() => onExit("menu")} aria-label="Menu">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFC14D" strokeWidth="1.8"><path d="M5 7h14M5 12h14M5 17h14"/></svg>
          MENU
        </button>
      </div>

      {sheet === "stats" && (
        <div className="statov" onClick={() => setSheet(null)}>
          <div className="statcard" role="dialog" aria-label="Match stats" onClick={(e) => e.stopPropagation()}>
            <b>MATCH</b>
            <div className="statrow"><span>{sideLabel(0)}</span><strong style={{ color: GOLD }}>{scores[0]}</strong></div>
            <div className="statrow"><span>{sideLabel(1)}</span><strong style={{ color: BLUE }}>{scores[1]}</strong></div>
            <div className="statrow"><span>CLOCK</span><strong>{winner === null && !waitingStart ? `${turnSecLeft}s` : "—"}</strong></div>
            <div className="statrow"><span>PORTS</span><strong>{portsIn === null ? "HOLD" : `${portsIn}s`}</strong></div>
            <div className="statrow"><span>RELAY</span><strong>×{streak || 0}</strong></div>
            <div className="statrow"><span>TURN</span><strong style={{ fontSize: 16 }}>{winner !== null ? "DONE" : sideLabel(turn === 1 ? 1 : 0)}</strong></div>
            <button type="button" onClick={() => setSheet(null)}>CLOSE</button>
          </div>
        </div>
      )}

      {winner !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(5,6,12,0.88)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, zIndex: 10, padding: 20, textAlign: "center", backdropFilter: "blur(8px)" }}>
          <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 12, letterSpacing: 5, color: C.dim }}>
            {winner === "draw" ? "CIRCUIT BALANCED" : "FINAL"}
          </div>
          <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: "clamp(26px, 7vw, 44px)", letterSpacing: 2, color: winner === "draw" ? C.text : players[winner === "draw" ? 0 : winner], textShadow: winner === "draw" ? "none" : `0 0 24px ${players[winner]}` }}>
            {winLabel()}
          </div>
          <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 20, color: C.dim }}>
            <span style={{ color: players[0] }}>{scores[0]}</span> — <span style={{ color: players[1] }}>{scores[1]}</span>
          </div>
          <div style={{ height: 10 }} />
          {!oppLeft && (
            <button
              style={btn("rgba(12,18,16,0.4)", winner === "draw" ? C.text : players[winner === "draw" ? 0 : winner])}
              onClick={handleRematch}
              disabled={rematchState === "sent"}
            >
              {mode !== "online" ? "REMATCH"
                : rematchState === "sent" ? "WAITING FOR RIVAL…"
                : rematchState === "received" ? "ACCEPT REMATCH"
                : "REMATCH"}
            </button>
          )}
          <button type="button" style={{ ...btn("transparent", C.dim), boxShadow: "none", border: `1px solid ${C.line}`, fontSize: 11, padding: "10px 20px" }} onClick={() => onExit("menu")}>MENU</button>
        </div>
      )}
    </div>
  );
}
