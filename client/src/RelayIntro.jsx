import { useEffect, useState } from "react";

const VOLT = "#7DFFB2";
const AMP = "#E7A04A";

export default function RelayIntro({ onDone }) {
  const [reduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    const t = setTimeout(onDone, reduced ? 900 : 3000);
    return () => clearTimeout(t);
  }, [onDone, reduced]);

  return (
    <button type="button" className={reduced ? "relay-intro is-static" : "relay-intro"} onClick={onDone} aria-label="Relay. Tap to skip.">
      <style>{css}</style>
      <div className="stage" aria-hidden="true">
        <div className="board">
          <i className="pocket a" />
          <i className="pocket b" />
          <i className="pocket c" />
          <i className="pocket d" />
          <i className="spot" />
        </div>
        <i className="puck neutral" />
        <i className="puck charged" />
        <i className="puck striker" />
      </div>
      <div className="word" aria-hidden="true">
        <span style={{ color: VOLT, animationDelay: "1.35s" }}>R</span>
        <span style={{ color: VOLT, animationDelay: "1.43s" }}>E</span>
        <svg className="bolt" viewBox="0 0 24 36">
          <path d="M14 1 L4 20 H12 L8 35 L22 14 H13 Z" />
        </svg>
        <span style={{ color: AMP, animationDelay: "1.62s" }}>L</span>
        <span style={{ color: AMP, animationDelay: "1.7s" }}>A</span>
        <span style={{ color: AMP, animationDelay: "1.78s" }}>Y</span>
      </div>
      <div className="tag">NOTHING IS YOURS UNTIL IT MOVES</div>
    </button>
  );
}

const css = `
.relay-intro {
  position: fixed;
  inset: 0;
  z-index: 80;
  margin: 0;
  padding: 24px 16px;
  border: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  cursor: pointer;
  background: radial-gradient(ellipse at 50% 42%, #143728 0%, #06110C 58%, #020604 100%);
  animation: relayOut 0.45s ease 2.55s forwards;
}
.stage {
  position: relative;
  width: min(52vw, 196px);
  height: min(52vw, 196px);
  animation: boardIn 0.55s cubic-bezier(.16,.84,.32,1) both;
}
.board {
  position: absolute;
  inset: 0;
  border-radius: 22px;
  background:
    radial-gradient(circle at 50% 38%, #1E7A4C 0%, #0B3A24 72%),
    #4A2E18;
  box-shadow: 0 0 0 8px #4A2E18, 0 18px 40px #00000066;
}
.pocket {
  position: absolute;
  width: 14%;
  height: 14%;
  border-radius: 50%;
  background: #120A06;
  box-shadow: inset 0 0 0 2px #000;
}
.pocket.a { top: 7%; left: 7%; }
.pocket.b { top: 7%; right: 7%; }
.pocket.c { bottom: 7%; left: 7%; }
.pocket.d { bottom: 7%; right: 7%; }
.spot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 16%;
  height: 16%;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  border: 1.5px solid ${AMP}88;
}
.puck {
  position: absolute;
  width: 15%;
  height: 15%;
  border-radius: 50%;
  box-shadow: 0 2px 6px #0008;
}
.neutral { left: 62%; top: 34%; background: #D9C7A6; }
.charged {
  left: 62%;
  top: 34%;
  background: ${AMP};
  box-shadow: 0 0 16px ${AMP};
  opacity: 0;
  animation: charge 0.35s ease 1.12s forwards, ring 0.7s ease 1.12s;
}
.striker {
  left: 16%;
  top: 64%;
  background:
    radial-gradient(circle at 50% 50%, ${VOLT} 0 22%, transparent 24%),
    #F7F3EA;
  box-shadow: 0 0 14px ${VOLT}88;
  animation: strike 0.7s cubic-bezier(.17,.84,.28,1) 0.48s forwards;
}
.bolt {
  width: 22px;
  height: 32px;
  margin: 0 2px 2px;
  opacity: 0;
  fill: ${AMP};
  filter: drop-shadow(0 0 8px ${AMP});
  animation: letter 0.35s ease 1.52s forwards, boltFlash 0.6s ease 1.7s;
}
.word {
  display: flex;
  align-items: center;
  font-family: 'Audiowide', sans-serif;
  font-size: clamp(42px, 12vw, 68px);
  letter-spacing: 6px;
  line-height: 1;
}
.word span {
  display: inline-block;
  opacity: 0;
  transform: translateY(14px);
  animation: letter 0.42s cubic-bezier(.16,.84,.32,1) forwards;
}
.tag {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  letter-spacing: 2.5px;
  color: #9ED9B8;
  opacity: 0;
  animation: letter 0.5s ease 1.95s forwards;
}
@keyframes boardIn { from { opacity: 0; transform: scale(.72); } to { opacity: 1; transform: none; } }
@keyframes strike { to { left: 49%; top: 36%; } }
@keyframes charge { to { opacity: 1; } }
@keyframes ring {
  0% { box-shadow: 0 0 0 0 ${AMP}; }
  100% { box-shadow: 0 0 0 18px transparent; }
}
@keyframes letter { to { opacity: 1; transform: none; } }
@keyframes boltFlash {
  0% { filter: drop-shadow(0 0 0 ${AMP}); }
  40% { filter: drop-shadow(0 0 16px ${VOLT}); }
  100% { filter: drop-shadow(0 0 8px ${AMP}); }
}
@keyframes relayOut { to { opacity: 0; visibility: hidden; } }
.relay-intro.is-static, .relay-intro.is-static * { animation: none !important; }
.relay-intro.is-static .striker { left: 49%; top: 36%; }
.relay-intro.is-static .charged,
.relay-intro.is-static .word span,
.relay-intro.is-static .bolt,
.relay-intro.is-static .tag { opacity: 1; transform: none; }
`;
