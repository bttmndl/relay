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

