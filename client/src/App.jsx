import { useCallback, useEffect, useState } from "react";
import RelayGame from "./RelayGame.jsx";
import RelayIntro from "./RelayIntro.jsx";
import { getSocket, SERVER_URL, loadIdentity, saveName, saveResume, loadResume, helloPayload, saveToken, signup, login, logout, rotateGuestId } from "./net.js";
import { THEMES, getTheme, loadStoredThemeId, storeThemeId } from "./themes.js";

export default function App() {
  const [screen, setScreen] = useState("menu"); // menu | online | game
  const [mode, setMode] = useState(null); // 'ai' | 'pvp' | 'online'
  const [session, setSession] = useState(null); // { playerIndex, startAt, nonce }
  const [status, setStatus] = useState(null); // lobby status text
  const [roomCode, setRoomCode] = useState(null); // code I host
  const [joinInput, setJoinInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [profile, setProfile] = useState(null);
  const [leaders, setLeaders] = useState([]);
  const [recent, setRecent] = useState([]);
  const [name, setName] = useState(() => loadIdentity().name);
  const [intro, setIntro] = useState(true);
  const [authMode, setAuthMode] = useState(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const dismissIntro = useCallback(() => setIntro(false), []);
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
    const onConnect = () => {
      setConnected(true);
      socket.emit("hello", helloPayload(name));
      const token = loadResume();
      if (token) socket.emit("resume", { token });
    };
    const onDisconnect = () => setConnected(false);
    const onWaiting = () => setStatus("Searching for a rival…");
    const onRoomCreated = ({ roomCode }) => {
      setRoomCode(roomCode);
      setStatus(null);
    };
    const onStart = (payload) => {
      if (payload.resumeToken) saveResume(payload.resumeToken);
      setSession({
        playerIndex: payload.playerIndex,
        startAt: payload.startAt,
        nonce: Date.now(),
        snapshot: payload.snapshot || null,
        resumed: !!payload.resumed,
      });
      setMode("online");
      setScreen("game");
      setIntro(false);
      setStatus(null);
      setRoomCode(null);
    };
    const onError = ({ message }) => setStatus(message);
    const onProfile = (next) => setProfile(next);
    const onAuthExpired = () => {
      saveToken("");
      setAuthError("Sign in expired. Enter your password again.");
      setAuthMode("login");
      socket.emit("hello", helloPayload(name));
    };
    const onAuthRejected = () => {
      rotateGuestId();
      socket.emit("hello", helloPayload(name));
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("waiting", onWaiting);
    socket.on("roomCreated", onRoomCreated);
    socket.on("startGame", onStart);
    socket.on("resumed", onStart);
    socket.on("errorMsg", onError);
    socket.on("profile", onProfile);
    socket.on("authExpired", onAuthExpired);
    socket.on("authRejected", onAuthRejected);
    if (socket.connected) onConnect();
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("waiting", onWaiting);
      socket.off("roomCreated", onRoomCreated);
      socket.off("startGame", onStart);
      socket.off("resumed", onStart);
      socket.off("errorMsg", onError);
      socket.off("profile", onProfile);
      socket.off("authExpired", onAuthExpired);
      socket.off("authRejected", onAuthRejected);
    };
  }, [name]);

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
    if (mode === "online") {
      saveResume(null);
      getSocket().emit("leaveRoom");
    }
    setScreen("menu");
    setMode(null);
    setSession(null);
    setStatus(null);
    setRoomCode(null);
  };

  const identify = () => {
    saveName(name);
    getSocket().emit("hello", helloPayload(name));
  };

  const submitAuth = async (event) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const body = authMode === "signup"
        ? { email: authEmail, password: authPassword, name, region: loadIdentity().region }
        : { email: authEmail, password: authPassword };
      const result = authMode === "signup" ? await signup(body) : await login(body);
      saveToken(result.token);
      if (result.account?.name) {
        setName(result.account.name);
        saveName(result.account.name);
      }
      setProfile(result.account);
      setAuthPassword("");
      setAuthMode(null);
      getSocket().emit("hello", helloPayload(result.account?.name || name));
    } catch (err) {
      setAuthError(err.message || "Sign in failed");
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    await logout();
    setProfile(null);
    setAuthMode(null);
    getSocket().emit("hello", helloPayload(name));
  };

  const cancelLobby = () => {
    getSocket().emit("cancelSearch");
    setStatus(null);
    setRoomCode(null);
    setScreen("menu");
  };

  useEffect(() => {
    if (screen !== "online") return;
    let gone = false;
    fetch(`${SERVER_URL}/leaderboard`)
      .then((r) => r.json())
      .then((body) => {
        if (gone) return;
        setLeaders(body.leaders || []);
        setRecent(body.recent || []);
      })
      .catch(() => {});
    return () => { gone = true; };
  }, [screen, profile]);

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

  const field = {
    fontFamily: "'Space Mono', monospace", fontSize: 13, letterSpacing: 1,
    width: 220, textAlign: "center", background: C.panel, color: C.text,
    border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 8px", outline: "none",
  };
  const accountPanel = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
      {profile?.member ? (
        <>
          <div style={{ fontSize: 11, color: C.dim, letterSpacing: 1 }}>{profile.email}</div>
          <button type="button" style={{ ...btn(C.panel, C.dim), width: "auto", padding: "8px 16px", fontSize: 11, boxShadow: "none" }} onClick={signOut}>LOG OUT</button>
        </>
      ) : (
        <>
          {!authMode && (
            <button type="button" style={{ ...btn(C.panel, C.copper), width: "auto", padding: "10px 16px", fontSize: 11, boxShadow: "none" }} onClick={() => { setAuthMode("login"); setAuthError(""); }}>
              SIGN IN TO KEEP YOUR RATING
            </button>
          )}
          {authMode && (
            <form onSubmit={submitAuth} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              {authMode === "signup" && (
                <input value={name} onChange={(e) => setName(e.target.value.slice(0, 16))} placeholder="NAME" maxLength={16} style={field} />
              )}
              <input value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="EMAIL" type="email" autoComplete="email" style={field} />
              <input value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder="PASSWORD" type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} style={field} />
              {authError && <div style={{ color: "#FF6A6A", fontSize: 11, maxWidth: 240 }}>{authError}</div>}
              <button type="submit" disabled={authBusy} style={{ ...btn("#0E2415", C.volt), width: "auto", padding: "10px 16px", fontSize: 12 }}>
                {authBusy ? "PLEASE WAIT" : authMode === "signup" ? "CREATE ACCOUNT" : "SIGN IN"}
              </button>
              <button type="button" style={{ background: "none", border: 0, color: C.dim, fontFamily: "'Space Mono', monospace", fontSize: 11, cursor: "pointer" }} onClick={() => { setAuthMode(authMode === "login" ? "signup" : "login"); setAuthError(""); }}>
                {authMode === "login" ? "New here? Create an account" : "Already registered? Sign in"}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );

  const frame = (node) => node;

  if (screen === "game" && session) {
    return frame(
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
    return frame(
      <div style={page}>
        <h2 style={{ fontFamily: "'Audiowide', sans-serif", letterSpacing: 4, fontSize: 22, margin: 0 }}>
          <span style={{ color: C.volt }}>ONLINE</span> <span style={{ color: C.amp }}>1V1</span>
        </h2>
        <div style={{ fontSize: 11, color: connected ? C.volt : "#FF6A6A", letterSpacing: 1 }}>
          {connected ? `● SERVER CONNECTED${profile ? ` · ${profile.rating}` : ""}` : "● CONNECTING TO SERVER…"}
        </div>
        {accountPanel}
        {!profile?.member && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          onBlur={identify}
          placeholder="YOUR NAME"
          maxLength={16}
          style={field}
        />
        )}
        <div style={{ height: 10 }} />

        <button style={btn("#0E2415", C.volt)} onClick={() => { identify(); setStatus("Searching for a rival…"); getSocket().emit("quickMatch"); }}>
          ⚡ QUICK MATCH
        </button>
        <button style={btn("#241708", C.amp)} onClick={() => { identify(); setStatus(null); getSocket().emit("createRoom"); }}>
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
            onClick={() => { identify(); joinInput.length === 6 && getSocket().emit("joinRoom", { roomCode: joinInput }); }}
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
        {leaders.length > 0 && (
          <div style={{ marginTop: 18, width: "100%", maxWidth: 320, textAlign: "left" }}>
            <div style={{ fontFamily: "'Audiowide', sans-serif", fontSize: 10, letterSpacing: 3, color: C.dim, marginBottom: 8, textAlign: "center" }}>LADDER</div>
            {leaders.slice(0, 8).map((p, i) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderTop: `1px solid ${C.line}` }}>
                <span>{i + 1}. {p.name}</span>
                <span style={{ color: C.copper }}>{p.rating}</span>
              </div>
            ))}
            {recent.slice(0, 3).map((m) => (
              <div key={m.id} style={{ fontSize: 10, color: C.dim, marginTop: 6 }}>
                {m.players[0].name} {m.players[0].score}–{m.players[1].score} {m.players[1].name}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const reveal = {
    opacity: intro ? 0 : 1,
    transition: "opacity .55s ease",
  };

  // ---------------- main menu ----------------
  return (
    <div style={page}>
      <div style={{ ...reveal, fontFamily: "'Audiowide', sans-serif", fontSize: 11, letterSpacing: 5, color: C.dim }}>
        NOTHING IS YOURS UNTIL IT MOVES
      </div>
      <h1 id="relay-title" style={{ fontFamily: "'Audiowide', sans-serif", fontSize: "clamp(46px, 12vw, 70px)", letterSpacing: 8, margin: 0, opacity: intro ? 0 : 1 }}>
        <span style={{ color: C.volt }}>RE</span><span style={{ color: C.amp }}>LAY</span>
      </h1>
      <div style={{ ...reveal, display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: "100%" }}>
      <p style={{ color: C.dim, fontSize: 13, maxWidth: 340, lineHeight: 1.7, margin: "6px 0 16px" }}>
        16 pucks are neutral, plus one <b style={{ color: "#D6203F" }}>queen</b> worth 5 points in the center. The puck you flick is your <b style={{ color: C.hot }}>striker</b> — everything it touches gets charged your color. Pot a charged puck = 1 point + <b style={{ color: C.volt }}>shoot again</b>, 3 in a row banks a bonus point. Sink your striker = <b style={{ color: "#FF6A6A" }}>point to your rival</b>. If the queen is knocked off her spot, she reappears on the hardest open point.
        <br /><b style={{ color: C.text }}>Most banked wins — the match ends the moment it's decided.</b>
      </p>
      {accountPanel}
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
      {intro && (
        <RelayIntro
          onDone={dismissIntro}
          colors={{
            board: C.board,
            boardDeep: C.boardDeep,
            volt: C.volt,
            amp: C.amp,
            accent: C.copper,
            rail: theme.canvas.rail,
            feltTop: theme.canvas.surfaceTop,
            feltBottom: theme.canvas.surfaceBottom,
            puck: theme.neutral,
            pocket: theme.canvas.holeInner,
            face: "#F7F3EA",
            text: C.text,
          }}
        />
      )}
    </div>
  );
}
