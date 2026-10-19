import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
import { newToken, tokenHash, SESSION_MS } from "./auth.js";
import { cleanName, cleanRegion } from "./store.js";

const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  rating INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  draws INTEGER NOT NULL,
  played INTEGER NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  room_code TEXT,
  winner TEXT,
  delta INTEGER NOT NULL,
  players JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
`;

function accountFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    rating: row.rating,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    played: row.played,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function decodeWinner(value) {
  if (value === "0") return 0;
  if (value === "1") return 1;
  return value;
}

function expected(a, b) {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

async function importJson(pool, file) {
  if (!file || !fs.existsSync(file)) return;
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM accounts");
  if (count.rows[0].n > 0) return;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const account of Object.values(parsed.accounts || {})) {
      await client.query(
        `INSERT INTO accounts
          (id, name, region, rating, wins, losses, draws, played, email, password_hash, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          account.id, account.name, account.region || "unknown", account.rating ?? 1000,
          account.wins ?? 0, account.losses ?? 0, account.draws ?? 0, account.played ?? 0,
          account.email || null, account.passwordHash || null,
          account.createdAt ?? Date.now(), account.updatedAt ?? Date.now(),
        ],
      );
    }
    for (const [key, row] of Object.entries(parsed.sessions || {})) {
      await client.query(
        `INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [key, row.accountId, row.expiresAt],
      );
    }
    for (const match of parsed.matches || []) {
      await client.query(
        `INSERT INTO matches (id, at, room_code, winner, delta, players) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [match.id, match.at, match.roomCode, String(match.winner), match.delta ?? 0, JSON.stringify(match.players || [])],
      );
    }
    for (const room of parsed.rooms || []) {
      if (!room?.code) continue;
      await client.query(
        `INSERT INTO rooms (code, data, updated_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [room.code, JSON.stringify(room), Date.now()],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createPgStore(connectionString, fileToImport) {
  const pool = new Pool({ connectionString, max: 4 });
  await pool.query(SCHEMA);
  await importJson(pool, fileToImport);

  return {
    async count() {
      const result = await pool.query("SELECT COUNT(*)::int AS n FROM accounts");
      return result.rows[0].n;
    },
    async get(id) {
      const result = await pool.query("SELECT * FROM accounts WHERE id = $1", [id]);
      return accountFrom(result.rows[0]);
    },
    async findByEmail(email) {
      const result = await pool.query("SELECT * FROM accounts WHERE email = $1", [email]);
      return accountFrom(result.rows[0]);
    },
    async upsert(input) {
      const id = String(input.playerId || "");
      if (!id) throw new Error("playerId required");
      const prev = await this.get(id);
      const now = Date.now();
      const name = cleanName(input.name, prev?.name, id);
      const region = cleanRegion(input.region || prev?.region);
      if (!prev) {
        await pool.query(
          `INSERT INTO accounts
            (id, name, region, rating, wins, losses, draws, played, email, password_hash, created_at, updated_at)
           VALUES ($1,$2,$3,1000,0,0,0,0,NULL,NULL,$4,$4)`,
          [id, name, region, now],
        );
      } else {
        await pool.query("UPDATE accounts SET name = $2, region = $3, updated_at = $4 WHERE id = $1", [id, name, region, now]);
      }
      return this.get(id);
    },
    async register({ email, passwordHash, name, region, guestId }) {
      const existing = await this.findByEmail(email);
      if (existing) {
        const err = new Error("That email is already registered");
        err.status = 409;
        throw err;
      }
      const guest = guestId ? await this.get(guestId) : null;
      const source = guest && !guest.email ? guest : null;
      const now = Date.now();
      const id = crypto.randomUUID();
      const accountName = cleanName(name, source?.name, id);
      const accountRegion = cleanRegion(region || source?.region);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO accounts
            (id, name, region, rating, wins, losses, draws, played, email, password_hash, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id, accountName, accountRegion,
            source?.rating ?? 1000, source?.wins ?? 0, source?.losses ?? 0, source?.draws ?? 0, source?.played ?? 0,
            email, passwordHash, source?.createdAt ?? now, now,
          ],
        );
        if (source) await client.query("DELETE FROM accounts WHERE id = $1", [source.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.code === "23505") {
          const dup = new Error("That email is already registered");
          dup.status = 409;
          throw dup;
        }
        throw err;
      } finally {
        client.release();
      }
      return this.get(id);
    },
    async openSession(accountId) {
      const token = newToken();
      await pool.query(
        "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1,$2,$3)",
        [tokenHash(token), accountId, Date.now() + SESSION_MS],
      );
      return token;
    },
    async accountForToken(token) {
      if (!token) return null;
      const key = tokenHash(token);
      const result = await pool.query(
        `SELECT accounts.*, sessions.expires_at FROM sessions
         JOIN accounts ON accounts.id = sessions.account_id
         WHERE sessions.token_hash = $1`,
        [key],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (Number(row.expires_at) <= Date.now()) {
        await pool.query("DELETE FROM sessions WHERE token_hash = $1", [key]);
        return null;
      }
      return accountFrom(row);
    },
    async revoke(token) {
      if (!token) return;
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    },
    async recordMatch({ players, winner, roomCode }) {
      const at = Date.now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const loaded = [];
        for (const player of players) {
          let row = (await client.query("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", [player.playerId])).rows[0];
          if (!row) {
            const created = await this.upsert(player);
            row = (await client.query("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", [created.id])).rows[0];
          }
          loaded.push(accountFrom(row));
        }
        const [a, b] = loaded;
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
        for (const account of [a, b]) {
          await client.query(
            `UPDATE accounts SET rating = $2, wins = $3, losses = $4, draws = $5, played = $6, updated_at = $7 WHERE id = $1`,
            [account.id, account.rating, account.wins, account.losses, account.draws, account.played, at],
          );
        }
        const match = {
          id: `${at}-${roomCode || "room"}`,
          at,
          roomCode: roomCode || null,
          winner,
          delta,
          players: [a, b].map((p, i) => ({ id: p.id, name: p.name, score: players[i].score, rating: p.rating })),
        };
        await client.query(
          `INSERT INTO matches (id, at, room_code, winner, delta, players) VALUES ($1,$2,$3,$4,$5,$6)`,
          [match.id, match.at, match.roomCode, String(match.winner), match.delta, JSON.stringify(match.players)],
        );
        await client.query("DELETE FROM matches WHERE id IN (SELECT id FROM matches ORDER BY at DESC OFFSET 500)");
        await client.query("COMMIT");
        return match;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async leaderboard(limit = 20) {
      const result = await pool.query(
        `SELECT * FROM accounts WHERE email IS NOT NULL
         ORDER BY rating DESC, wins DESC, name ASC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => {
        const account = accountFrom(row);
        return {
          id: account.id, name: account.name, region: account.region, rating: account.rating,
          wins: account.wins, losses: account.losses, draws: account.draws, played: account.played,
          member: true,
        };
      });
    },
    async recent(limit = 8) {
      const result = await pool.query("SELECT * FROM matches ORDER BY at DESC LIMIT $1", [limit]);
      return result.rows.map((row) => ({
        id: row.id,
        at: Number(row.at),
        roomCode: row.room_code,
        winner: decodeWinner(row.winner),
        delta: row.delta,
        players: row.players,
      }));
    },
    async saveRooms(rooms) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM rooms");
        for (const room of rooms) {
          await client.query(
            "INSERT INTO rooms (code, data, updated_at) VALUES ($1,$2,$3)",
            [room.code, JSON.stringify(room), Date.now()],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async loadRooms() {
      const result = await pool.query("SELECT data FROM rooms");
      return result.rows.map((row) => row.data);
    },
  };
}
