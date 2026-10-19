import crypto from "node:crypto";

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (value.length < 6 || value.length > 80) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

export function passwordError(password) {
  const value = String(password || "");
  if (value.length < 8 || value.length > 72) return "Password must be 8 to 72 characters";
  return null;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return crypto.timingSafeEqual(next, prev);
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export async function identityFromHello(store, body = {}) {
  if (body.token) {
    const account = await store.accountForToken(body.token);
    if (!account) return { account: null, error: "Sign in expired", code: "expired" };
    return {
      account: await store.upsert({
        playerId: account.id,
        name: account.name,
        region: body.region || account.region,
      }),
      error: null,
    };
  }
  const requested = String(body.playerId || "");
  const existing = requested ? await store.get(requested) : null;
  if (existing?.email) return { account: null, error: "Sign in required", code: "rejected" };
  return {
    account: await store.upsert({
      playerId: requested || crypto.randomUUID(),
      name: body.name,
      region: body.region,
    }),
    error: null,
  };
}

