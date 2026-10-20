import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createStore } from "../store.js";
import { hashPassword, verifyPassword, identityFromHello, passwordError, EMAIL_TAKEN } from "../auth.js";

function tempStore() {
  const file = path.join(os.tmpdir(), `relay-auth-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const store = createStore(file);
  return { store, file };
}

test("password rules and one email only", () => {
  assert.equal(passwordError("short1"), "Password must be 8 to 72 characters");
  assert.equal(passwordError("longpassword"), "Password needs a letter and a number");
  assert.equal(passwordError("password1"), "Choose a less common password");
  assert.equal(passwordError("relaypuck1", "relaypuck1@relaypuck.com"), "Password cannot match the email");
  assert.equal(passwordError("relaypuck1", "volt@relaypuck.com"), null);

  const { store, file } = tempStore();
  store.register({ email: "volt@relaypuck.com", passwordHash: hashPassword("relaypuck1"), name: "Volt" });
  assert.throws(
    () => store.register({ email: "VOLT@relaypuck.com", passwordHash: hashPassword("relaypuck2"), name: "Other" }),
    (err) => err.status === 409 && err.message === EMAIL_TAKEN,
  );
  fs.unlinkSync(file);
});

test("password hash verifies only the same password", () => {
  const stored = hashPassword("correct horse");
  assert.equal(verifyPassword("correct horse", stored), true);
  assert.equal(verifyPassword("wrong horse", stored), false);
  assert.equal(verifyPassword("correct horse", "nope"), false);
});

test("signup keeps guest rating, login token loads it, and a copied id is refused", async () => {
  const { store, file } = tempStore();
  const guest = store.upsert({ playerId: "guest-1", name: "Volt", region: "Asia/Kolkata" });
  guest.rating = 1120;
  guest.wins = 3;
  guest.played = 4;
  store.save();
  const account = store.register({
    email: "volt@relaypuck.com",
    passwordHash: hashPassword("password1"),
    name: "Volt",
    region: "Asia/Kolkata",
    guestId: "guest-1",
  });
  assert.equal(account.rating, 1120);
  assert.equal(account.wins, 3);
  assert.equal(store.get("guest-1"), null);
  assert.equal(store.findByEmail("volt@relaypuck.com").id, account.id);
  assert.throws(() => store.register({
    email: "volt@relaypuck.com",
    passwordHash: hashPassword("password1"),
    name: "Other",
  }), (err) => err.status === 409);

  const token = store.openSession(account.id);
  const again = createStore(file);
  const seen = await identityFromHello(again, { token, region: "Asia/Kolkata" });
  assert.equal(seen.account.id, account.id);
  assert.equal(seen.account.email, "volt@relaypuck.com");
  assert.equal((await identityFromHello(again, { token: "stolen" })).code, "expired");
  assert.equal((await identityFromHello(again, { playerId: account.id, name: "Hacker" })).code, "rejected");

  const guestHello = await identityFromHello(again, { playerId: "someone-else", name: "Amp" });
  assert.equal(guestHello.account.member || guestHello.account.email, null);
  assert.equal(again.leaderboard(5).some((row) => row.id === guestHello.account.id), false);
  assert.equal(again.leaderboard(5)[0].id, account.id);

  again.revoke(token);
  assert.equal(again.accountForToken(token), null);
  fs.unlinkSync(file);
});
