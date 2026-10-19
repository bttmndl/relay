# RELAY ⚡

*Nothing is yours until it moves.*

A flick game with no match clock, but each turn is on its own shot clock. 16 pucks are neutral, plus one special **queen** worth 5 points that starts in the center. The puck you flick becomes your **striker**, and everything it touches gets charged your color. Pot a charged puck for a point and shoot again. Sink your striker and the point goes to your rival (**poison**). Play runs until every puck — queen included — is off the board, or until the trailing player can no longer mathematically catch up — whichever comes first.

## Stack

- **client/** — Vite + React (plain JS), canvas rendering, deterministic physics engine
- **server/** — Express + Socket.IO (thin relay: matchmaking, input relay, state sync)

Online play uses input-lockstep: both clients run the identical fixed-timestep engine (`client/src/engine.js`), the server just relays each flick `{idx, ang, v}`. After every shot the shooter sends a position/score snapshot which the opponent snaps to, so tiny float drift can never accumulate.

## Local development

Terminal 1 — server:
```bash
cd server
npm install
npm start          # listens on :3001
```

Terminal 2 — client:
```bash
cd client
npm install
cp .env.example .env    # VITE_SERVER_URL=http://localhost:3001
npm run dev             # opens on :5173
```

Open two browser windows on `localhost:5173` → PLAY ONLINE → Create Room in one, Join with the code in the other.

## Deployment (Render + Vercel)

### Server → Render
1. Push this repo to GitHub.
2. Render → New → **Web Service** → pick the repo.
3. **Root Directory:** `server`
4. **Build Command:** `npm install` — **Start Command:** `npm start`
5. Environment variables:
   - `CLIENT_ORIGIN` = extra allowed sites, comma-separated. `https://relaypuck.com`, `https://www.relaypuck.com`, localhost, and Capacitor are already allowed.
   - `DATABASE_URL` = Render Postgres internal URL. Leave this unset only for local play, which uses a JSON file.
   - `RELAY_DATA_FILE` = optional JSON path used when `DATABASE_URL` is not set. Defaults to `server/data/store.json`.
6. Note the service URL, e.g. `https://relay-d0fn.onrender.com`.

The server checks every flick, keeps a 45 second reconnect window, and stores accounts plus results. Without `DATABASE_URL` it uses `server/data/store.json`, which a Render restart can wipe. With `DATABASE_URL` set to a Render Postgres **internal** URL, accounts, sessions, matches, and open rooms are stored in Postgres. The first boot copies an existing `store.json` if the database is empty.

Paid setup: the web service instance is **0.5c-512mb** (not the free instance, and not a paid workspace plan). Postgres is the smallest paid plan, created in the same region. Do not use Render's free database.

Sign-in is email and password. `POST /auth/signup`, `POST /auth/login`, and `POST /auth/logout` issue a bearer token stored in the browser. The socket sends that token with `hello`. Guests can still play, but only signed-in accounts appear on the ladder, and a copied player id cannot take over a registered account. Creating an account keeps the rating already earned on that device. Passwords are stored as scrypt hashes.

Free-tier note: Render free instances sleep after inactivity; the first connection after a sleep takes ~30–50s. The client shows "CONNECTING TO SERVER…" until the socket is up.

### Client → Vercel
1. Vercel → New Project → same repo.
2. **Root Directory:** `client` (framework auto-detects Vite).
3. Environment variable:
   - `VITE_SERVER_URL` = your Render URL (e.g. `https://relay-server-xxxx.onrender.com`)
4. Deploy. Remember: `VITE_*` variables are baked in at build time — redeploy after changing them. `https://relaypuck.com` is already on the server allowlist.

## Project layout

```
relay/
├── README.md
├── server/
│   ├── package.json
│   └── index.js            # rooms, quick match, flick relay, sync relay, rematch
└── client/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    ├── .env.example
    └── src/
        ├── main.jsx
        ├── App.jsx         # menu + online lobby
        ├── net.js          # socket singleton (VITE_SERVER_URL)
        ├── engine.js       # deterministic game logic (shared by all modes)
        └── RelayGame.jsx   # canvas rendering, input, sfx, net hooks
```

## Game rules (v1)

- 16 neutral pucks + 1 queen, 4 corner ports, no match clock
- **Shot clock:** each player has `TURN_SECONDS` (20s) to take their shot, shown as a draining border around their score chip. It resets fresh after every resolved shot — a RELAY streak gets a new window each time, not just a turn change. Run out the clock and the turn passes with no score, same as any other foul
- On your turn flick **any** puck — it becomes your striker
- Chain charging: striker or any charged puck touching a neutral puck charges it your color
- **Scoring:** a regular puck potted → 1 point (charge owner if charged, otherwise the shooter). The **queen** → `QUEEN_POINTS` (5 points), no extra condition. Either way the shooter keeps the turn ("RELAY ×n" streaks)
- **The queen:** starts in the center. She sits there like any other puck — collide with her, charge her, knock her around — until someone pots her. If a shot moves her and she is still on the board, she is placed on the open spot that is currently hardest to pot into the live pocket, scored the same way the hot port picks the hardest hole. Once potted, she's gone for good.
- Potting 3 pucks in a row within one unbroken turn (3, 6, 9…) → an extra `STREAK_BONUS_POINTS` (1) on top
- Striker potted → +1 for the opponent, turn passes (POISON)
- **Match end:** the board is completely empty (queen included), *or* the trailing player becomes mathematically unable to catch up even in the best case (they clear everything left, the leader scores nothing more) — whichever happens first. That second rule is what keeps a lopsided match from grinding on forever. Equal scores when the board empties → draw
- **Hot ports:** only 1 of the 4 corner ports is live (glowing) at a time — whichever is currently the *hardest* to pot into, given the live puck layout. It stays live for as long as it holds that title; the moment another pocket overtakes it, a 5s warning countdown appears before it actually shifts. Sinking any puck into a dead port passes your turn and costs you 1 point (unless you're already at 0). A regular puck also gets sent back to center; the queen isn't "potted" by a dead port at all, so it just stays put — nudged clear of that pocket's mouth.

## Tuning knobs

- Friction: `0.985` in `engine.js` (stepGame)
- Max flick power: `S * 0.036` (RelayGame input + AI)
- Pocket capture radius: `pocketR * 0.72`
- AI aggression: alignment gate `dot > 0` in `aiChooseShot` — deliberately loose since the live pocket is always the hardest one on the board; a stricter bar left the AI unable to find a "confident" shot most turns
- Shot clock: `TURN_SECONDS` (20s, `engine.js`) — resets on every `finishShot`, enforced by `turnTimeoutPass` when it runs out mid-`stepGame`
- Scoring: `QUEEN_POINTS` (5), `STREAK_BONUS_EVERY` (3), `STREAK_BONUS_POINTS` (1) — all in `engine.js`
- Queen: starts at the center. After a shot that moves her, `hardestSpawnSpot` in `engine.js` grids the open board and picks the point with the worst shot into the live pocket, the same scoring as `pocketEase`.
- Mercy rule: `checkClinched`/`maxRemainingPoints` in `engine.js` — ends the match the instant no realistic board state could still change the outcome
- Hot ports: the live pocket is whichever is currently hardest to pot into (`hardestPocket`/`pocketEase` in `engine.js`, scored the same way as the AI's own shot-quality heuristic). A challenger must hold that title for `PORT_SHIFT_WARNING_SECONDS` (5s) before the port actually shifts to it. Potting into a dead port ends your turn and deducts 1 point from the shooter (floored at 0); a regular puck also returns to center, but the queen just gets nudged clear of the pocket mouth since it isn't "potted" by that — see `getLivePorts`/`portRotateInfo`.
