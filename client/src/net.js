import { io } from "socket.io-client";

const URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io(URL, { transports: ["websocket", "polling"], autoConnect: true });
  }
  return socket;
}
