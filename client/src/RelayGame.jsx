import { useEffect, useRef, useState } from "react";
import {
  createGame, launch, stepGame, serialize, applySync, aiChooseShot,
  getLivePorts, portRotateInfo, MATCH_SECONDS, PCOL, PNAME,
} from "./engine.js";
import { getSocket } from "./net.js";

const C = {
  board: "#0B1F16", boardDeep: "#06110C", panel: "#10221A", line: "#1E3A2C",
  copper: "#C97F3D", volt: "#7CFF4A", hot: "#F4FFF0", neutral: "#93A8A0",
  text: "#E8F5EC", dim: "#7C948A",
};
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
    tick: () => blip(1000, 1000, 0.03, "sine", 0.05),
    win: () => { blip(330, 660, 0.3, "sine", 0.1); setTimeout(() => blip(495, 990, 0.4, "sine", 0.1), 150); },
  };
}

// mode: 'ai' | 'pvp' | 'online'
// online: { playerIndex, startAt } (socket via getSocket())
export default function RelayGame({ mode, online, onExit }) {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const size = Math.min(440, w - 20);

  const [turn, setTurn] = useState(0);
  const [scores, setScores] = useState([0, 0]);
  const [timeLeft, setTimeLeft] = useState(MATCH_SECONDS);
  const [sudden, setSudden] = useState(false);
  const [winner, setWinner] = useState(null);
  const [callout, setCallout] = useState(null);
  const [waitingStart, setWaitingStart] = useState(mode === "online");
  const [oppLeft, setOppLeft] = useState(false);
  const [rematchState, setRematchState] = useState(null); // 'sent' | 'received'
  const [emoteFx, setEmoteFx] = useState(null);
  const [portsIn, setPortsIn] = useState(0);

  const canvasRef = useRef(null);
  const G = useRef(null);
  const sfx = useRef(null);
  const arcs = useRef([]);
  const rejects = useRef([]);
  const drag = useRef(null);
  const timerId = useRef(null);
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
    setScores([0, 0]); setTurn(0); setWinner(null); setSudden(false);
    setTimeLeft(MATCH_SECONDS);

    const startClock = () => {
      setWaitingStart(false);
      say(
        mode === "online"
          ? me === 0 ? "YOU ARE VOLT — you shoot first" : "YOU ARE AMP — Volt shoots first"
          : "VOLT first — everything you touch becomes yours",
        PCOL[mode === "online" ? me : 0], 2400);
      timerId.current = setInterval(() => {
        const g = G.current;
        if (!g || g.winner !== null || g.sudden) return;
        g.timeLeft = Math.max(0, g.timeLeft - 1);
        setTimeLeft(g.timeLeft);
        if (g.timeLeft <= 10 && g.timeLeft > 0) sfx.current?.tick();
        if (g.timeLeft === 0) g.timeUp = true;
      }, 1000);
    };

    if (mode === "online") {
      const delay = Math.max(0, online.startAt - Date.now());
      const t = setTimeout(startClock, delay);
      return () => { clearTimeout(t); clearInterval(timerId.current); };
    }
    startClock();
    return () => clearInterval(timerId.current);
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
      setSudden(g.sudden); setTimeLeft(g.timeLeft);
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
        say("POISON! STRIKER SUNK", PCOL[e.player], 1500);
      }
      else if (e.t === "deadPort") {
        sfx.current?.reject();
        rejects.current.push({ x: e.x, y: e.y, t: 1 });
        say("PORT OFFLINE — RETURNED", "#FF6A6A", 1400);
      }
      else if (e.t === "streak") say(`RELAY ×${e.n}`, PCOL[e.player], 1200);
      else if (e.t === "turn") setTurn(e.turn);
      else if (e.t === "sudden") { setSudden(true); say("SUDDEN DEATH — NEXT POT WINS", C.hot, 2200); }
      else if (e.t === "end") { sfx.current?.win(); setTimeout(() => setWinner(e.winner), 600); }
      else if (e.t === "shotDone") {
        if (mode === "online" && e.shooter === me) {
          g.timeLeft = timeLeftRefSafe(g);
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
  const timeLeftRefSafe = (g) => g.timeLeft;

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
      const nextPortsIn = Math.ceil(portRotateInfo(g).framesToNext / 60);
      if (nextPortsIn !== lastPortsIn) { lastPortsIn = nextPortsIn; setPortsIn(nextPortsIn); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const render = (ctx, g, pulse) => {
    const { S, R, pad } = g;
    ctx.clearRect(0, 0, S, S);

    const bg = ctx.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, "#0D2419");
    bg.addColorStop(1, C.boardDeep);
    ctx.fillStyle = bg;
    rr(ctx, pad * 0.35, pad * 0.35, S - pad * 0.7, S - pad * 0.7, 16);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = C.copper;
    ctx.globalAlpha = 0.9;
    rr(ctx, pad * 0.35, pad * 0.35, S - pad * 0.7, S - pad * 0.7, 16);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // copper traces to ports
    ctx.strokeStyle = "rgba(201,127,61,0.35)";
    ctx.lineWidth = 2;
    g.pockets.forEach((pk) => {
      ctx.beginPath();
      ctx.moveTo(g.cx, g.cy);
      ctx.lineTo(pk.x + (g.cx - pk.x) * 0.35, g.cy);
      ctx.lineTo(pk.x, pk.y);
      ctx.stroke();
    });
    ctx.fillStyle = "rgba(201,127,61,0.5)";
    g.pockets.forEach((pk) => {
      ctx.beginPath();
      ctx.arc(pk.x + (g.cx - pk.x) * 0.35, g.cy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, R * 5.6, 0, Math.PI * 2);
    ctx.setLineDash([2, 7]);
    ctx.strokeStyle = "rgba(201,127,61,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // ports — only the "live" ones (getLivePorts) accept a pot; the rest
    // sit dim until the rotation brings them back online
    const liveGates = getLivePorts(g);
    const { framesToNext } = portRotateInfo(g);
    const flicker = framesToNext < 45 && Math.floor(framesToNext / 4) % 2 === 0;
    g.pockets.forEach((pk, pi) => {
      const isLive = liveGates.includes(pi) && !flicker;
      const glow = isLive ? C.volt : C.copper;
      const grad = ctx.createRadialGradient(pk.x, pk.y, 1, pk.x, pk.y, g.pocketR);
      grad.addColorStop(0, "#000");
      grad.addColorStop(0.75, "#04120B");
      grad.addColorStop(1, "rgba(4,18,11,0)");
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
        ctx.strokeStyle = `${C.volt}66`;
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
        ctx.strokeStyle = doom ? "rgba(255,80,80,0.9)" : reject ? "rgba(255,160,46,0.85)" : `${PCOL[g.turn]}AA`;
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
        ctx.strokeStyle = `${PCOL[g.turn]}55`;
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
      const col = p.striker ? PCOL[g.turn] : p.charge !== null ? PCOL[p.charge] : C.neutral;
      const hot = p.striker || p.charge !== null;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.shadowColor = col;
      ctx.shadowBlur = hot ? 16 : 4;
      const grad = ctx.createRadialGradient(-rad * 0.3, -rad * 0.3, 1, 0, 0, rad);
      grad.addColorStop(0, hot ? "#22352A" : "#18241E");
      grad.addColorStop(1, "#0A140F");
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
  const mm = String(Math.floor(timeLeft / 60));
  const ss = String(timeLeft % 60).padStart(2, "0");
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
    <div style={{ minHeight: "100vh", background: `linear-gradient(180deg, ${C.board}, ${C.boardDeep})`, color: C.text, fontFamily: "'Space Mono', monospace", display: "flex", flexDirection: "column", alignItems: "center", paddingBottom: 40, userSelect: "none", WebkitUserSelect: "none" }}>
      <style>{`
        @keyframes rlIn { from{opacity:0; transform:scale(.85)} to{opacity:1; transform:scale(1)} }
        @keyframes rlPulse { 0%,100%{opacity:.55} 50%{opacity:1} }
        @keyframes rlCall { 0%{opacity:0; transform:translateX(-50%) scale(.7)} 15%{opacity:1; transform:translateX(-50%) scale(1.08)} 30%{transform:translateX(-50%) scale(1)} 80%{opacity:1} 100%{opacity:0; transform:translateX(-50%) translateY(-12px)} }
        @keyframes rlEmote { 0%{opacity:0; transform:translateY(10px) scale(.6)} 20%{opacity:1; transform:translateY(0) scale(1.1)} 35%{transform:scale(1)} 80%{opacity:1} 100%{opacity:0; transform:translateY(-20px)} }
        @media (prefers-reduced-motion: reduce){ *{animation:none !important} }
      `}</style>

      {/* HUD */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: size, padding: "14px 4px 8px", gap: 8 }}>
        {[0, 1].map((p) => (
          <div key={p} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${turn === p && winner === null ? PCOL[p] : C.line}`, boxShadow: turn === p && winner === null ? `0 0 14px ${PCOL[p]}44` : "none", minWidth: 88, position: "relative" }}>
            <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 8, letterSpacing: 1.5, color: PCOL[p], whiteSpace: "nowrap" }}>{nameFor(p)}</div>
            <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 24, color: PCOL[p] }}>{scores[p]}</div>
            {emoteFx && emoteFx.side === p && (
              <div key={emoteFx.key} style={{ position: "absolute", top: -26, fontSize: 24, animation: "rlEmote 1.8s ease-out forwards" }}>{emoteFx.emote}</div>
            )}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", top: 18, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 24, letterSpacing: 2, color: sudden ? C.hot : timeLeft <= 30 ? "#FF6A6A" : C.text, animation: timeLeft <= 30 && !sudden && winner === null ? "rlPulse 1s infinite" : "none" }}>
          {sudden ? "⚡" : `${mm}:${ss}`}
        </div>
        <div style={{ fontSize: 8, letterSpacing: 2, color: C.dim }}>{sudden ? "NEXT POT WINS" : "MATCH CLOCK"}</div>
        {winner === null && !waitingStart && (
          <div style={{ fontSize: 8, letterSpacing: 1, color: portsIn <= 3 ? "#FF6A6A" : C.copper, marginTop: 2, animation: portsIn <= 3 ? "rlPulse 0.6s infinite" : "none" }}>
            PORTS SHIFT {portsIn}s
          </div>
        )}
      </div>

      <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 10, letterSpacing: 3, color: PCOL[turn], margin: "2px 0 8px", animation: "rlPulse 1.6s infinite", minHeight: 14 }}>
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
          <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: "clamp(26px, 7vw, 44px)", letterSpacing: 3, color: winner === "draw" ? C.text : PCOL[winner === "draw" ? 0 : winner], textShadow: winner === "draw" ? "none" : `0 0 24px ${PCOL[winner]}` }}>
            {winLabel()}
          </div>
          <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 20, color: C.dim }}>
            <span style={{ color: PCOL[0] }}>{scores[0]}</span> — <span style={{ color: PCOL[1] }}>{scores[1]}</span>
          </div>
          <div style={{ height: 10 }} />
          {!oppLeft && (
            <button
              style={btn("#0E2415", winner === "draw" ? C.text : PCOL[winner === "draw" ? 0 : winner])}
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
