import fs from "node:fs";
import path from "node:path";

const EMPTY = () => ({ accounts: {}, matches: [], rooms: [] });

export function createStore(file) {
  const data = EMPTY();

  function load() {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      data.accounts = parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {};
      data.matches = Array.isArray(parsed.matches) ? parsed.matches : [];
      data.rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
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
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      data.accounts[id] = account;
      save();
      return account;
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
  const { id, name, region, rating, wins, losses, draws, played } = account;
  return { id, name, region, rating, wins, losses, draws, played };
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
