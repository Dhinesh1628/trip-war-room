# Trip War Room

A real-time, multiplayer trip-planning board. A group joins one Trip Room, pins
activities and lodging to a day-by-day itinerary, votes on contested slots,
tracks a shared budget, chats, and asks an AI Concierge questions that are
answered only from a locally authored venue dataset and always obey the
group's budget, dietary, opening-hours and distance constraints.

> Status: **Phase 2 done.** Auth, four-role access control, the Lisbon venue
> dataset, trips and invites, plus the live board: pin, move, lock, conflict
> handling for simultaneous moves, presence, chat, reconnects and leader
> moderation over WebSockets. The AI Concierge comes in Phase 3 and the full UI
> in Phase 5 (see [Roadmap](#roadmap)).

Docs: [API reference](docs/API.md) · [Decisions and deviations](docs/DECISIONS.md) ·
[Postman collection](docs/postman/trip-war-room.postman_collection.json)

## Track and stack

- **Track A — Full-Stack** (spec section 4.3)
- **Stack: Option B — MERN**: MongoDB + Mongoose, Express 5, Socket.io 4,
  React 19 (Vite), plain JavaScript, Jest + Supertest.

## Project layout

```
trip-war-room/
  server/   Express REST API + Socket.io gateway (one process, one port)
    src/config/     environment + database connection
    src/auth/       register/login/refresh, JWT, role rules
    src/trips/      trip rooms, invite codes, per-trip access checks
    src/venues/     destinations, venues, dataset validator + loader
    src/admin/      admin-only dataset upload
    src/board/      board state machine, in-memory rooms, background saving
    src/chat/       chat messages, cleaning, reactions
    src/realtime/   Board Sync Gateway: /trips namespace and event handlers
    data/destinations/  authored venue datasets (lisbon.json)
    scripts/        seed, make-admin, smoke test, live room demo, dev:memory
    test/           Jest tests (use an in-memory MongoDB, no setup needed)
  client/   React app (Vite dev server proxies /api and /socket.io)
```

## Prerequisites

- Node.js 22 or newer (developed on Node 24)
- MongoDB: a local server **or** a free MongoDB Atlas cluster.
  The tests do **not** need either; they start their own in-memory MongoDB.

## Setup

1. Install dependencies for both halves:

   ```bash
   npm run install:all
   ```

2. Create the server's environment file from the example:

   ```bash
   cp server/.env.example server/.env
   ```

   (PowerShell: `Copy-Item server/.env.example server/.env`)

3. Edit `server/.env`:
   - `MONGO_URI`: your local or Atlas connection string.
   - `JWT_SECRET`: a long random string. Generate one with
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - If Atlas fails with `querySrv ECONNREFUSED` (common on Windows), uncomment
     `DNS_SERVERS=8.8.8.8,1.1.1.1`.

   `.env` is git-ignored. Never commit real secrets.

4. Load the venue dataset into your database (safe to run again):

   ```bash
   npm run seed --prefix server
   ```

   Expected output: `lisbon.json: lisbon (lisbon-2026.11-1) - 42 venues ...`

5. Optional: make an Admin. Register an account first (through the API or,
   from Phase 5, the app), then:

   ```bash
   npm run make-admin --prefix server -- you@example.com
   ```

   Add `--revoke` to take the role away again.

## Run (development)

Open two terminals:

```bash
npm run dev --prefix server
```

```bash
npm run dev --prefix client
```

No MongoDB yet? Use `npm run dev:memory --prefix server` instead of the first
command. It starts a temporary in-memory database with the datasets already
loaded (no `.env` or seed needed; all data is lost when you stop it).

- Client: <http://localhost:5180>
- API + WebSocket gateway: <http://localhost:5080>

The client page is still a status page for now: it shows whether the REST API,
the database and the real-time gateway are reachable, plus a measured WebSocket
round trip.

Ports 5080 and 5180 were chosen to avoid clashing with other local projects
(5060 would not work: browsers block it as an "unsafe" port).
To change the server port, set `PORT` in `server/.env` and start the client
with `VITE_API_PROXY=http://localhost:<port>`.

## Test

```bash
npm test
```

This runs the server's Jest suite (against an in-memory MongoDB; the first run
downloads a MongoDB binary, which can take a minute) and then builds the client.

What the suites cover:

| File | Covers |
|---|---|
| `auth.test.js` | register/login, token expiry and forgery, refresh rotation and reuse detection, logout, preferences, rate limiting |
| `rbac.test.js` | every protected action tried by outsider, Viewer, Planner, Leader and Admin |
| `trips.test.js` | trip creation and validation, invite codes, joining, capacity (including 5 people racing for the last seat) |
| `venues.test.js` | distance maths, proximity search checked against a brute-force calculation, query validation |
| `dataset.test.js` | the Lisbon data covers every constraint type; bad uploads are rejected with clear messages |
| `boardState.test.js` | the board state machine on its own: lifecycle, version checks, exact budget cents, chat cleaning |
| `realtime.test.js` | real Socket.io clients: handshake auth, snapshots, sync under 100 ms, 20 rounds of simultaneous moves, locks, leader disconnect, presence and reconnects, chat, moderation |
| `health.test.js`, `gateway.test.js` | health checks, config safety, WebSocket ping/pong |

### Smoke test against a running server

With the server running (`npm run dev --prefix server`), in another terminal:

```bash
npm run smoke --prefix server
```

It registers two throwaway accounts, creates a trip, joins it, and checks that a
Viewer and a Leader are blocked from actions above their role. It prints PASS or
FAIL per check and the request timings.

### Live room demo (several travellers at once)

With the server running:

```bash
npm run demo:room --prefix server
```

Three scripted travellers join one Trip Room. Two of them drag the same card at
the same moment (one wins, the other is told), the leader locks a card, and
someone chats. The script prints what each traveller saw, then the measured
sync drift and whether all three boards agree.

### Postman

Import [docs/postman/trip-war-room.postman_collection.json](docs/postman/trip-war-room.postman_collection.json)
and run it with the Collection Runner. Every request has assertions; folder 5
shows the server rejecting requests above the caller's role.

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /api/v1/health` | REST API up; reports database connection state (503 if the DB is down) |
| `GET /api/v1/health/gateway` | Real-time gateway up; reports connected clients |

## Roadmap

| Phase | Scope |
|---|---|
| 0 | Project setup, health checks, test harness |
| 1 | Auth (JWT + refresh), four-role RBAC, venue dataset, trips and invites |
| 2 | Real-time board: pin/move/lock, optimistic concurrency, presence, chat, moderation |
| 3 | AI Concierge: hard-constraint matcher, RAG answers with citations, conflict detector, voting |
| 4 | Budget engine, recommendations, session analytics, admin venue upload |
| 5 | Full UI (after mockup approval) |
| 6 | Load testing, measured performance, security pass, final docs |

## AI assistance

This project was built with help from an AI coding assistant (Claude). All
design decisions, code and results are reviewed and understood by the author.
