# Trip War Room

A real-time, multiplayer trip-planning board. A group joins one Trip Room, pins
activities and lodging to a day-by-day itinerary, votes on contested slots,
tracks a shared budget, chats, and asks an AI Concierge questions that are
answered only from a locally authored venue dataset and always obey the
group's budget, dietary, opening-hours and distance constraints.

> Status: **Phase 0 — project setup.** The server, real-time gateway, client
> and test suite are wired together. Features arrive phase by phase (see
> [Roadmap](#roadmap)).

## Track and stack

- **Track A — Full-Stack** (spec section 4.3)
- **Stack: Option B — MERN**: MongoDB + Mongoose, Express 5, Socket.io 4,
  React 19 (Vite), plain JavaScript, Jest + Supertest.

## Project layout

```
trip-war-room/
  server/   Express REST API + Socket.io gateway (one process, one port)
    src/config/     environment + database connection
    src/realtime/   Board Sync Gateway (kept separate from the REST app)
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

## Run (development)

Open two terminals:

```bash
npm run dev --prefix server
```

```bash
npm run dev --prefix client
```

No MongoDB yet? Use `npm run dev:memory --prefix server` instead of the first
command. It starts a temporary in-memory database (no `.env` needed; all data
is lost when you stop it).

- Client: <http://localhost:5180>
- API + WebSocket gateway: <http://localhost:5060>

The Phase 0 page shows whether the REST API, the database and the real-time
gateway are reachable, plus a measured WebSocket round trip.

Ports 5060 and 5180 were chosen to avoid clashing with other local projects.
To change the server port, set `PORT` in `server/.env` and start the client
with `VITE_API_PROXY=http://localhost:<port>`.

## Test

```bash
npm test
```

This runs the server's Jest suite (against an in-memory MongoDB; the first run
downloads a MongoDB binary, which can take a minute) and then builds the client.

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
