import { io } from "socket.io-client";

export const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const ID_KEY = "relay-player-id";
const NAME_KEY = "relay-player-name";
const RESUME_KEY = "relay-resume";

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io(SERVER_URL, { transports: ["websocket", "polling"], autoConnect: true });
  }
  return socket;
}

export function loadIdentity() {
  let playerId = localStorage.getItem(ID_KEY);
  if (!playerId) {
    playerId = crypto.randomUUID();
    localStorage.setItem(ID_KEY, playerId);
  }
  let region = "unknown";
  try { region = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"; } catch { /* ignore */ }
  return { playerId, name: localStorage.getItem(NAME_KEY) || "", region };
}

export function saveName(name) {
  localStorage.setItem(NAME_KEY, name);
}

export function saveResume(token) {
  if (token) sessionStorage.setItem(RESUME_KEY, token);
  else sessionStorage.removeItem(RESUME_KEY);
}

export function loadResume() {
  return sessionStorage.getItem(RESUME_KEY);
}

const TOKEN_KEY = "relay-session";

export function loadToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function saveToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function rotateGuestId() {
  localStorage.removeItem(ID_KEY);
  return loadIdentity().playerId;
}

export function helloPayload(name) {
  const id = loadIdentity();
  return { ...id, name: name || id.name, token: loadToken() };
}

async function postAuth(path, body, token = loadToken()) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Sign in failed");
  return data;
}

export function signup(body) {
  return postAuth("/auth/signup", { ...body, guestId: loadIdentity().playerId });
}

export function login(body) {
  return postAuth("/auth/login", body);
}

export function googleAuth(credential) {
  const id = loadIdentity();
  return postAuth("/auth/google", { credential, guestId: id.playerId, region: id.region });
}

export function logout() {
  const token = loadToken();
  saveToken("");
  if (!token) return Promise.resolve();
  return postAuth("/auth/logout", {}, token).catch(() => {});
}

