import { useEffect, useState } from "react";
import RelayGame from "./RelayGame.jsx";
import { getSocket } from "./net.js";
import { THEMES, getTheme, loadStoredThemeId, storeThemeId } from "./themes.js";

export default function App() {
  const [screen, setScreen] = useState("menu"); // menu | online | game
  const [mode, setMode] = useState(null); // 'ai' | 'pvp' | 'online'
  const [session, setSession] = useState(null); // { playerIndex, startAt, nonce }
  const [status, setStatus] = useState(null); // lobby status text
  const [roomCode, setRoomCode] = useState(null); // code I host
  const [joinInput, setJoinInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [themeId, setThemeId] = useState(loadStoredThemeId);
  const theme = getTheme(themeId);
  const C = {
    board: theme.ui.board, boardDeep: theme.ui.boardDeep, panel: theme.ui.panel, line: theme.ui.line,
    copper: theme.accent, volt: theme.players[0], amp: theme.players[1], hot: theme.ui.hot,
    text: theme.ui.text, dim: theme.ui.dim,
  };
  const chooseTheme = (id) => { setThemeId(id); storeThemeId(id); };

  // socket lifecycle — App owns matchmaking events
  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onWaiting = () => setStatus("Searching for a rival…");
    const onRoomCreated = ({ roomCode }) => {
      setRoomCode(roomCode);
      setStatus(null);
    };
    const onStart = ({ playerIndex, startAt }) => {
      setSession({ playerIndex, startAt, nonce: Date.now() });
      setMode("online");
      setScreen("game");
      setStatus(null);
      setRoomCode(null);
    };
    const onError = ({ message }) => setStatus(message);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("waiting", onWaiting);
    socket.on("roomCreated", onRoomCreated);
    socket.on("startGame", onStart);
    socket.on("errorMsg", onError);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("waiting", onWaiting);
      socket.off("roomCreated", onRoomCreated);
      socket.off("startGame", onStart);
      socket.off("errorMsg", onError);
    };
  }, []);

  const startLocal = (m) => {
    setMode(m);
    setSession({ nonce: Date.now() });
    setScreen("game");
  };

  const exitGame = (why) => {
    if (why === "restart" && mode !== "online") {
      setSession({ nonce: Date.now() });
      return;
    }
    if (mode === "online") getSocket().emit("leaveRoom");
    setScreen("menu");
    setMode(null);
    setSession(null);
    setStatus(null);
    setRoomCode(null);
  };

  const cancelLobby = () => {
    getSocket().emit("cancelSearch");
    setStatus(null);
    setRoomCode(null);
    setScreen("menu");
  };

  // ---------------- styles ----------------
  const btn = (bg, col) => ({
    fontFamily: "'Audiowide', sans-serif", fontSize: 14, letterSpacing: 2,
    color: col, background: bg, border: `2px solid ${col}`, borderRadius: 10,
    padding: "14px 28px", cursor: "pointer", boxShadow: `0 0 18px ${col}44`,
    width: 260,
  });
  const page = {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${C.board}, ${C.boardDeep})`,
    color: C.text,
    fontFamily: "'Space Mono', monospace",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 10, padding: 20, textAlign: "center",
  };

  if (screen === "game" && session) {
    return (
      <RelayGame
        key={session.nonce}
        mode={mode}
        online={mode === "online" ? session : null}
        onExit={exitGame}
        theme={theme}
      />
    );
  }

  if (screen === "online") {
    return (
      <div style={page}>
        <h2 style={{ fontFamily: "'Audiowide', sans-serif", letterSpacing: 4, fontSize: 22, margin: 0 }}>
          <span style={{ color: C.volt }}>ONLINE</span> <span style={{ color: C.amp }}>1V1</span>
        </h2>
        <div style={{ fontSize: 11, color: connected ? C.volt : "#FF6A6A", letterSpacing: 1 }}>
          {connected ? "● SERVER CONNECTED" : "● CONNECTING TO SERVER…"}
        </div>
        <div style={{ height: 10 }} />

        <button style={btn("#0E2415", C.volt)} onClick={() => { setStatus("Searching for a rival…"); getSocket().emit("quickMatch"); }}>
          ⚡ QUICK MATCH
        </button>
        <button style={btn("#241708", C.amp)} onClick={() => { setStatus(null); getSocket().emit("createRoom"); }}>
          CREATE ROOM
        </button>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <input
            value={joinInput}
            onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            maxLength={6}
            style={{
              fontFamily: "'Space Mono', monospace", fontSize: 16, letterSpacing: 4,
              width: 150, textAlign: "center", background: C.panel, color: C.text,
              border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 8px", outline: "none",
            }}
          />
          <button
            style={{ ...btn(C.panel, C.hot), width: "auto", padding: "12px 18px", boxShadow: "none", border: `1px solid ${C.hot}` }}
            onClick={() => joinInput.length === 6 && getSocket().emit("joinRoom", { roomCode: joinInput })}
          >
            JOIN
          </button>
        </div>

        {roomCode && (
          <div style={{ marginTop: 14, padding: "14px 22px", background: C.panel, border: `1px solid ${C.copper}`, borderRadius: 12 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: C.dim, marginBottom: 6 }}>SHARE THIS CODE — WAITING FOR RIVAL</div>
            <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 30, letterSpacing: 8, color: C.copper }}>{roomCode}</div>
          </div>
        )}
        {status && <div style={{ marginTop: 10, fontSize: 12, color: C.hot }}>{status}</div>}

        <div style={{ height: 14 }} />
        <button style={{ ...btn(C.panel, C.dim), width: "auto", padding: "10px 20px", fontSize: 11, boxShadow: "none", border: `1px solid ${C.line}` }} onClick={cancelLobby}>
          BACK
        </button>
      </div>
    );
  }

  // ---------------- main menu ----------------
  return (
    <div style={page}>
      <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 11, letterSpacing: 5, color: C.dim }}>
        NOTHING IS YOURS UNTIL IT MOVES
      </div>
      <h1 style={{ fontFamily: "'Audiowide', sans-serif", fontSize: "clamp(46px, 12vw, 70px)", letterSpacing: 8, margin: 0 }}>
        <span style={{ color: C.volt }}>RE</span><span style={{ color: C.amp }}>LAY</span>
      </h1>
      <p style={{ color: C.dim, fontSize: 13, maxWidth: 340, lineHeight: 1.7, margin: "6px 0 26px" }}>
        16 pucks are neutral, plus one <b style={{ color: "#D6203F" }}>queen</b> at the center. The puck you flick is your <b style={{ color: C.hot }}>striker</b> — everything it touches gets charged your color. Pot a charged puck = point + <b style={{ color: C.volt }}>shoot again</b>. Sink your striker = <b style={{ color: "#FF6A6A" }}>point to your rival</b>. Pot the queen and cover it with one of your own before your turn ends, or it returns to center.
        <br /><b style={{ color: C.text }}>Board empty, most banked wins.</b>
      </p>
      <button style={btn("#0E2415", C.volt)} onClick={() => setScreen("online")}>PLAY ONLINE</button>
      <button style={btn("#241708", C.amp)} onClick={() => startLocal("ai")}>PLAY VS AI</button>
      <button style={{ ...btn(C.panel, C.text), boxShadow: "none", border: `1px solid ${C.line}` }} onClick={() => startLocal("pvp")}>PASS &amp; PLAY</button>

      <div style={{ marginTop: 28, width: "100%", maxWidth: 360 }}>
        <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 10, letterSpacing: 3, color: C.dim, marginBottom: 10 }}>
          BOARD THEME
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
          {THEMES.map((t) => {
            const selected = t.id === themeId;
            return (
              <button
                key={t.id}
                onClick={() => chooseTheme(t.id)}
                title={t.tagline}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  width: 90, padding: "10px 6px", borderRadius: 10, cursor: "pointer",
                  background: t.ui.panel, border: `2px solid ${selected ? t.accent : t.ui.line}`,
                  boxShadow: selected ? `0 0 14px ${t.accent}66` : "none",
                }}
              >
                <div style={{ display: "flex", gap: 4 }}>
                  {t.swatch.map((sw, i) => (
                    <span key={i} style={{
                      width: 14, height: 14, borderRadius: "50%", background: sw,
                      border: `1px solid ${t.ui.line}`, boxShadow: i > 0 ? `0 0 5px ${sw}88` : "none",
                    }} />
                  ))}
                </div>
                <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 8, letterSpacing: 1, color: t.ui.text, textAlign: "center", lineHeight: 1.3 }}>
                  {t.name}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
