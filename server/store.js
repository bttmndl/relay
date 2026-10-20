import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { newToken, tokenHash, SESSION_MS, EMAIL_TAKEN } from "./auth.js";

const EMPTY = () => ({ accounts: {}, matches: [], rooms: [], sessions: {} });

export function createStore(file) {
  const data = EMPTY();

  function load() {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      data.accounts = parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {};
      data.matches = Array.isArray(parsed.matches) ? parsed.matches : [];
      data.rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
      data.sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  load();

  return {
    load,
    save,
    data,
    count: () => Object.keys(data.accounts).length,
    get: (id) => data.accounts[id] || null,
    findByEmail(email) {
      const needle = String(email || "").toLowerCase();
      return Object.values(data.accounts).find((account) => String(account.email || "").toLowerCase() === needle) || null;
    },
    upsert(input) {
      const id = String(input.playerId || "");
      if (!id) throw new Error("playerId required");
      const now = Date.now();
      const prev = data.accounts[id];
      const name = cleanName(input.name, prev?.name, id);
      const account = {
        id,
        name,
        region: cleanRegion(input.region || prev?.region),
        rating: prev?.rating ?? 1000,
        wins: prev?.wins ?? 0,
        losses: prev?.losses ?? 0,
        draws: prev?.draws ?? 0,
        played: prev?.played ?? 0,
        email: prev?.email || null,
        passwordHash: prev?.passwordHash || null,
        googleSub: prev?.googleSub || null,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      data.accounts[id] = account;
      save();
      return account;
    },
    register({ email, passwordHash, name, region, guestId, googleSub }) {
      if (this.findByEmail(email)) {
        const err = new Error(EMAIL_TAKEN);
        err.status = 409;
        throw err;
      }
      const guest = guestId && data.accounts[guestId] && !data.accounts[guestId].email
        ? data.accounts[guestId]
        : null;
      const now = Date.now();
      const id = crypto.randomUUID();
      const account = {
        id,
        email,
        passwordHash: passwordHash || null,
        googleSub: googleSub || null,
        name: cleanName(name, guest?.name, id),
        region: cleanRegion(region || guest?.region),
        rating: guest?.rating ?? 1000,
        wins: guest?.wins ?? 0,
        losses: guest?.losses ?? 0,
        draws: guest?.draws ?? 0,
        played: guest?.played ?? 0,
        createdAt: guest?.createdAt ?? now,
        updatedAt: now,
      };
      if (guest) delete data.accounts[guest.id];
      data.accounts[id] = account;
      save();
      return account;
    },
    linkGoogle(id, googleSub) {
      const account = data.accounts[id];
      if (!account) return null;
      if (account.googleSub && account.googleSub !== googleSub) {
        const err = new Error(EMAIL_TAKEN);
        err.status = 409;
        throw err;
      }
      account.googleSub = googleSub;
      account.updatedAt = Date.now();
      save();
      return account;
    },
    openSession(accountId) {
      const token = newToken();
      const mine = Object.entries(data.sessions).filter(([, row]) => row.accountId === accountId);
      mine.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      while (mine.length >= 5) {
        const [old] = mine.shift();
        delete data.sessions[old];
      }
      data.sessions[tokenHash(token)] = { accountId, expiresAt: Date.now() + SESSION_MS };
      save();
      return token;
    },
    accountForToken(token) {
      if (!token) return null;
      const key = tokenHash(token);
      const row = data.sessions[key];
      if (!row) return null;
      if (row.expiresAt <= Date.now()) {
        delete data.sessions[key];
        save();
        return null;
      }
      return data.accounts[row.accountId] || null;
    },
    revoke(token) {
      if (!token) return;
      delete data.sessions[tokenHash(token)];
      save();
    },
    recordMatch({ players, winner, roomCode }) {
      const at = Date.now();
      const [a, b] = players.map((p) => data.accounts[p.playerId] || this.upsert(p));
      let delta = 0;
      if (winner === 0 || winner === 1) {
        const win = winner === 0 ? a : b;
        const lose = winner === 0 ? b : a;
        delta = Math.max(1, Math.round(24 * (1 - expected(win.rating, lose.rating))));
        win.rating += delta;
        lose.rating = Math.max(100, lose.rating - delta);
        win.wins += 1;
        lose.losses += 1;
      } else {
        a.draws += 1;
        b.draws += 1;
      }
      a.played += 1;
      b.played += 1;
      a.updatedAt = at;
      b.updatedAt = at;
      const match = {
        id: `${at}-${roomCode || "room"}`,
        at,
        roomCode: roomCode || null,
        winner,
        delta,
        players: [a, b].map((p, i) => ({
          id: p.id,
          name: p.name,
          score: players[i].score,
          rating: p.rating,
        })),
      };
      data.matches.push(match);
      if (data.matches.length > 500) data.matches.splice(0, data.matches.length - 500);
      save();
      return match;
    },
    leaderboard(limit = 20) {
      return Object.values(data.accounts)
        .filter((account) => account.email)
        .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map(publicAccount);
    },
    recent(limit = 8) {
      return data.matches.slice(-limit).reverse();
    },
    saveRooms(rooms) {
      data.rooms = rooms;
      save();
    },
    loadRooms() {
      return data.rooms;
    },
  };
}

export function publicAccount(account) {
  if (!account) return null;
  const { id, name, region, rating, wins, losses, draws, played, email } = account;
  return { id, name, region, rating, wins, losses, draws, played, member: !!email };
}

export function selfAccount(account) {
  if (!account) return null;
  return { ...publicAccount(account), email: account.email || null };
}

export function cleanName(name, previous, id) {
  const raw = String(name || "").replace(/[^\w .'-]/g, "").trim().slice(0, 16);
  if (raw.length >= 2) return raw;
  if (previous && previous.length >= 2) return previous;
  return `PUCK${String(id).replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase() || "0000"}`;
}

export function cleanRegion(region) {
  const raw = String(region || "unknown").replace(/[^\w/+.-]/g, "").slice(0, 64);
  return raw || "unknown";
}

function expected(a, b) {
  return 1 / (1 + 10 ** ((b - a) / 400));
}
