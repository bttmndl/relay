import { useEffect, useRef, useState } from "react";

export default function RelayIntro({ onDone, colors }) {
  const rootRef = useRef(null);
  const wordRef = useRef(null);
  const [reduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    let landTimer = 0;
    const start = setTimeout(() => {
      const title = document.getElementById("relay-title");
      const word = wordRef.current;
      const root = rootRef.current;
      if (!title || !word || !root) {
        onDone();
        return;
      }
      const from = word.getBoundingClientRect();
      const to = title.getBoundingClientRect();
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const scale = to.width / from.width || 1;
      word.style.transition = "transform .62s cubic-bezier(.45,0,.15,1)";
      word.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      root.classList.add("is-landing");
      landTimer = setTimeout(onDone, 640);
    }, reduced ? 280 : 2050);
    return () => {
      clearTimeout(start);
      clearTimeout(landTimer);
    };
  }, [onDone, reduced]);

  const felt = `linear-gradient(160deg, ${colors.feltTop}, ${colors.feltBottom})`;

  return (
    <div ref={rootRef} className={reduced ? "relay-intro is-static" : "relay-intro"}>
      <style>{css}</style>
      <button type="button" className="skip" onClick={onDone} aria-label="Skip intro" />
      <div className="backdrop" style={{ background: `linear-gradient(180deg, ${colors.board}, ${colors.boardDeep})` }} />
      <div className="lockup">
        <div className="stage" aria-hidden="true">
          <div className="board" style={{ background: felt, boxShadow: `0 0 0 8px ${colors.rail}, 0 18px 40px #0006` }}>
            <i className="pocket a" style={{ background: colors.pocket }} />
            <i className="pocket b" style={{ background: colors.pocket }} />
            <i className="pocket c" style={{ background: colors.pocket }} />
            <i className="pocket d" style={{ background: colors.pocket }} />
            <i className="spot" style={{ borderColor: colors.accent }} />
          </div>
          <i className="puck neutral" style={{ background: colors.puck }} />
          <i className="puck charged" style={{ background: colors.amp, boxShadow: `0 0 16px ${colors.amp}` }} />
          <i className="puck striker" style={{ background: `radial-gradient(circle at 50% 50%, ${colors.volt} 0 22%, transparent 24%), ${colors.face}` }} />
        </div>
        <div
          ref={wordRef}
          className="word"
          style={{ color: colors.text, fontSize: "clamp(46px, 12vw, 70px)", letterSpacing: 8 }}
        >
          <span style={{ color: colors.volt, animationDelay: "1.15s" }}>RE</span>
          <span style={{ color: colors.amp, animationDelay: "1.32s" }}>LAY</span>
        </div>
      </div>
    </div>
  );
}

const css = `
.relay-intro { position: fixed; inset: 0; z-index: 80; pointer-events: none; }
.skip { position: absolute; inset: 0; z-index: 2; margin: 0; padding: 0; border: 0; background: transparent; cursor: pointer; pointer-events: auto; }
.backdrop { position: absolute; inset: 0; transition: opacity .62s ease; }
.lockup {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
}
.stage {
  position: relative;
  width: min(52vw, 196px);
  height: min(52vw, 196px);
  animation: boardIn .55s cubic-bezier(.16,.84,.32,1) both;
  transition: opacity .45s ease, transform .62s ease;
}
.board { position: absolute; inset: 0; border-radius: 22px; }
.pocket { position: absolute; width: 14%; height: 14%; border-radius: 50%; box-shadow: inset 0 0 0 2px #000; }
.pocket.a { top: 7%; left: 7%; }
.pocket.b { top: 7%; right: 7%; }
.pocket.c { bottom: 7%; left: 7%; }
.pocket.d { bottom: 7%; right: 7%; }
.spot {
  position: absolute; left: 50%; top: 50%; width: 16%; height: 16%;
  border-radius: 50%; border: 1.5px solid; transform: translate(-50%, -50%);
}
.puck { position: absolute; width: 15%; height: 15%; border-radius: 50%; box-shadow: 0 2px 6px #0008; }
.neutral { left: 62%; top: 34%; }
.charged { left: 62%; top: 34%; opacity: 0; animation: charge .35s ease 1.05s forwards, ring .7s ease 1.05s; }
.striker { left: 16%; top: 64%; animation: strike .7s cubic-bezier(.17,.84,.28,1) .42s forwards; }
.word {
  font-family: 'Audiowide', sans-serif;
  line-height: 1;
  margin: 0;
  transform-origin: center center;
  z-index: 3;
}
.word span {
  display: inline-block;
  opacity: 0;
  transform: translateY(12px);
  animation: letter .42s cubic-bezier(.16,.84,.32,1) forwards;
}
.is-landing .backdrop { opacity: 0; }
.is-landing .stage { opacity: 0; transform: scale(.82) translateY(-8px); }
.is-static .stage, .is-static .word span, .is-static .charged, .is-static .striker { animation: none; }
.is-static .word span, .is-static .charged { opacity: 1; transform: none; }
.is-static .striker { left: 49%; top: 36%; }
@keyframes boardIn { from { opacity: 0; transform: scale(.76); } to { opacity: 1; transform: none; } }
@keyframes strike { to { left: 49%; top: 36%; } }
@keyframes charge { to { opacity: 1; } }
@keyframes ring { from { box-shadow: 0 0 0 0 currentColor; } to { box-shadow: 0 0 0 16px transparent; } }
@keyframes letter { to { opacity: 1; transform: none; } }
`;
