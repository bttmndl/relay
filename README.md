# RELAY ⚡

*Nothing is yours until it moves.*

A flick game with no match clock, but each turn is on its own shot clock. 16 pucks are neutral, plus one special **queen** at the center — the puck you flick becomes your **striker**, and everything it touches gets charged your color. Pot a charged puck for a point and shoot again. Sink your striker and the point goes to your rival (**poison**). Pot the queen and you must cover it — pot one of your own before your turn ends — or it returns to center unclaimed. Play runs until every puck is off the board; whoever banked the most wins.

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
   - `CLIENT_ORIGIN` = your Vercel URL (e.g. `https://relay-yourname.vercel.app`) — or leave unset for `*` while testing.
6. Note the service URL, e.g. `https://relay-server-xxxx.onrender.com`.

Free-tier note: Render free instances sleep after inactivity; the first connection after a sleep takes ~30–50s. The client shows "CONNECTING TO SERVER…" until the socket is up.

### Client → Vercel
1. Vercel → New Project → same repo.
2. **Root Directory:** `client` (framework auto-detects Vite).
3. Environment variable:
   - `VITE_SERVER_URL` = your Render URL (e.g. `https://relay-server-xxxx.onrender.com`)
4. Deploy. Remember: `VITE_*` variables are baked in at build time — redeploy after changing them.

Then set `CLIENT_ORIGIN` on Render to the final Vercel domain and redeploy the server (locks CORS to your app).

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

- 16 neutral pucks + 1 queen, 4 corner ports, no match clock — play continues until the board is empty
- **Shot clock:** each player has `TURN_SECONDS` (20s) to take their shot, shown as a draining border around their score chip. It resets fresh after every resolved shot — a RELAY streak gets a new window each time, not just a turn change. Run out the clock and the turn passes with no score, same as any other foul (a pending queen goes uncovered too)
- On your turn flick **any** puck — it becomes your striker
- Chain charging: striker or any charged puck touching a neutral puck charges it your color
- Charged puck potted → +1 for its charge owner, shooter keeps the turn ("RELAY ×n" streaks)
- Striker potted → +1 for the opponent, turn passes (POISON)
- Uncharged drifter potted → +1 for the shooter
- **The queen:** a special center puck (like carrom's red goti). Potting it banks no points by itself and keeps your turn — you then must pot one of your own regular pucks before the turn passes to "cover" it and bank the `QUEEN_BONUS` (2 points). Fail to cover it before the turn ends and it returns, uncovered, to the center
- Board empty → highest score wins; equal scores → draw
- **Hot ports:** only 1 of the 4 corner ports is live (glowing) at a time — whichever is currently the *hardest* to pot into, given the live puck layout. It stays live for as long as it holds that title; the moment another pocket overtakes it, a 5s warning countdown appears before it actually shifts. Sinking any puck into a dead port returns it to center and passes your turn — no score, no poison.

## Tuning knobs

- Friction: `0.985` in `engine.js` (stepGame)
- Max flick power: `S * 0.036` (RelayGame input + AI)
- Pocket capture radius: `pocketR * 0.72`
- AI aggression: alignment threshold `dot > 0.72` in `aiChooseShot`
- Shot clock: `TURN_SECONDS` (20s, `engine.js`) — resets on every `finishShot`, enforced by `turnTimeoutPass` when it runs out mid-`stepGame`
- Hot ports: the live pocket is whichever is currently hardest to pot into (`hardestPocket`/`pocketEase` in `engine.js`, scored the same way as the AI's own shot-quality heuristic). A challenger must hold that title for `PORT_SHIFT_WARNING_SECONDS` (5s) before the port actually shifts to it. Potting into a dead port returns that puck to center and ends your turn (no score) — see `getLivePorts`/`portRotateInfo`.
