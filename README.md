# Trip War Room

A real-time, multiplayer trip-planning board. A group joins one Trip Room, pins
activities and lodging to a day-by-day itinerary, votes on contested slots,
tracks a shared budget, chats, and asks an AI Concierge questions that are
answered only from a locally authored venue dataset and always obey the
group's budget, dietary, opening-hours and distance constraints.

> Status: **complete (all six phases).** Auth and four-role access control;
> trips and invites; the live board (pin, drag to move, lock, simultaneous-move
> conflicts, presence, chat, reconnects, moderation); the AI Concierge
> (rule-checked, cited suggestions; conflict detector; contested-slot votes);
> an exact budget engine (attendance, even and weighted splits, budget-split
> votes); session analytics from an event log; hybrid recommendations; the
> dashboard; admin dataset upload; load-tested, measured and reviewed.

## Documentation

| Document | What's in it |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | The system as built, with a diagram and the main request paths |
| [Data model](docs/DATA-MODEL.md) | Collections, indexes and the ER diagram |
| [API reference](docs/API.md) | Every REST endpoint and WebSocket event, with example payloads |
| [Performance](docs/PERFORMANCE.md) | Measured numbers against every target in spec 10.2 |
| [Security](docs/SECURITY.md) | The security review |
| [Test report](docs/TEST-REPORT.md) | What is tested, the results, and evidence for each acceptance criterion |
| [Decisions](docs/DECISIONS.md) | Every decision and deviation from the spec, with reasons, phase by phase |
| [Demo walkthrough](docs/DEMO.md) | A script for the live demo or recording |
| [Deploying](docs/DEPLOY.md) | Putting it online on Render, step by step |
| [Retrospective](docs/RETROSPECTIVE.md) | What was built, what was cut, what's next |
| [Postman collection](docs/postman/trip-war-room.postman_collection.json) | The REST flow, with assertions |

## Results at a glance

| Spec target | Result |
|---|---|
| Sync drift < 100 ms | P95 **1–6 ms**, including 50 travellers in one room |
| Fan-out < 500 ms | P95 **1–6 ms** |
| Simultaneous moves on one card | 125 of 125 rounds: one applied, one told, every board identical |
| 100% constraint compliance (≥ 20 requests) | **379 requests, 0 violations** |
| Conflicts flagged within 1 s | max **19 ms** (20 of 20) |
| Budget math 100% accurate | exact to the cent over 2,000 random splits and 300 random trips |
| Precision@5 ≥ 0.6 | **0.735** |
| Analytics reconcile with the event log | exact (test and live trip) |
| REST P95 < 200 ms | **≤ 10 ms** with a local database; 110–383 ms over a remote free-tier Atlas cluster (network-bound; explained in the performance report) |
| AI Concierge P95 < 3 s | template 230 ms; free local model 14.8 s; Claude not measured (no API credits); a 2.5 s timeout caps Claude by design |

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
    src/concierge/  AI Concierge: question reading, hard-rule matcher, ranking,
                    grounded answers (Claude, local model or template), conflict detector
    src/analytics/  session analytics from the event log
    src/recs/       interactions, hybrid recommender, data generator, Precision@5
    src/users/      profile, preferences, dashboard
    data/destinations/  authored venue datasets (lisbon.json)
    scripts/        seed, make-admin, smoke test, live room demo, Concierge and
                    recommender evaluations, interaction generator, dev:memory
    test/           Jest tests (use an in-memory MongoDB, no setup needed)
  client/   React 19 app (Vite dev server proxies /api and /socket.io)
    src/lib/        API client (token in memory, refresh cookie), auth, live room hook
    src/pages/      sign in, dashboard, join, trip room, analytics, admin
    src/pages/room/ board, dialogs, votes, budget, Concierge, chat, people, ideas
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
   - Optional: choose who writes the Concierge's wording. The suggestions
     themselves are always picked and checked by the rules in code.
     - **Nothing set:** a fixed template. Free, no setup.
     - **Free local model:** install [Ollama](https://ollama.com), run
       `ollama pull llama3.2:3b` (about 2 GB), and set `CONCIERGE_PROVIDER=ollama`.
     - **Claude (paid):** set `ANTHROPIC_API_KEY` (from
       <https://platform.claude.com>, with credits added). Each question with at
       least one matching venue is one API call (`claude-opus-5-5`, low effort).

     `GET /api/v1/health/gateway` shows which one is active (`concierge`).

   `.env` is git-ignored. Never commit real secrets.

4. Load the venue dataset into your database (safe to run again):

   ```bash
   npm run seed --prefix server
   ```

   Expected output: `lisbon.json: lisbon (lisbon-2026.11-1) - 42 venues ...`

   Optional: give the recommendation engine some history to learn from
   (120 synthetic travellers, about 1,700 interactions; safe to run again):

   ```bash
   npm run generate:interactions --prefix server
   ```

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

### Using the app

1. Open <http://localhost:5180> and create an account.
2. On the dashboard, start a trip (destination, dates, group budget). You become
   its leader. The invite code is shown at the top of the trip room; click it
   to copy a join link.
3. To see live sync, open the join link in a **second browser profile or a
   private window** (a second account needs its own cookies), register another
   traveller, and join.

What you can do in a trip room:

| Area | What it does |
|---|---|
| Board | One column per day. "Pin a venue" opens the catalog with filters. Drag a card to another day; open it to change the time, who's going, or how the cost is split; leaders can lock it as final |
| Votes | Two cards in the same slot open a vote automatically; everyone, Viewers included, picks one. "Put it to a vote" on a card proposes a cost split for a yes/no vote |
| Warnings | Overlaps, impossible travel, venues booked while closed, and budget breaches appear at the top the moment they happen |
| Budget | Group total against the budget, and each person's exact share (in red if over their own ceiling) |
| Concierge | Ask in plain words ("vegan lunch under $20"); the answer cites its sources and has a "Pin it" button |
| Chat | Messages, typing indicator, reactions (shown as icons), and system notices for votes, conflicts and moderation |
| People | Who's online and their connection quality; leaders can mute, remove, change roles, hand over the leader role, close the room to new people and replace the invite code |
| Ideas | "Recommended for your group", with the reason for each |

Other pages: **Analytics** (link in the trip room) shows the session numbers and
the final cost per person, and confirms the event log replays exactly to the
board. **Datasets** (admins only, in the top bar) checks and uploads a
destination's venue file.

On a phone the board shows one day at a time (swipe sideways), and the panels
become tabs below it. Light and dark mode follow your system setting.

Dragging works with a mouse. On touch screens, open a card and change its day
or time there.

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
| `constraints.test.js` | **100% constraint compliance**: 379 simulated Concierge requests checked against an independent re-implementation of the four rules; opening hours past midnight; the 40/30/30 ranking |
| `concierge.unit.test.js` | reading questions, the grounding check, the Claude call (with a fake client: request shape, and falling back on bad ids, invented prices, refusals, timeouts), the conflict detector, voting rules |
| `concierge.test.js` | end to end: the spec's example question over REST and WebSocket, room broadcast, declines, rate limit, conflicts flagged within 1 s (20 tries), budget breaches, votes resolving identically for every client |
| `ollama.test.js` | the free local-model path against a fake Ollama server: request shape, quality check, every fallback |
| `budget.test.js` | **budget math, 100% exact**: hand-worked splits and a hand-worked trip, 2,000 random splits and 300 random trips that must add up to the cent |
| `recs.test.js` | content-based and collaborative parts, co-traveller boost, cold start, group filters, **Precision@5 ≥ 0.6** on the held-out set |
| `phase4.test.js` | end to end: attendance and weighted splits, budget-split votes, **a hand-worked session whose analytics must reconcile exactly with the event log**, recommendations, the dashboard, feedback |
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
someone chats. The script prints what each traveller saw, the measured sync
drift, and whether all three boards agree. Then it prints the trip's session
analytics, including whether the event log replays to exactly the stored
board, and the group's recommendations.

### Concierge evaluation

With the server running:

```bash
npm run eval:concierge --prefix server
```

It creates a trip, pins a 5 PM walking tour, asks 12 fixed questions, and
re-checks every suggestion against the venue data. It prints each answer, the
answer mode (`llm`, `template` or `no_match`), the constraint compliance and the
end-to-end latency (median and P95). **If `ANTHROPIC_API_KEY` is set, a run
makes about 11 paid Claude API calls.**

### Recommendation evaluation

No server needed:

```bash
npm run eval:recs --prefix server
```

It generates the synthetic interaction dataset with 5 different random seeds
and prints Precision@5 on held-out "next trip" likes, for popularity,
content-only, collaborative-only and the hybrid model. Last run: hybrid mean
**0.735** (target ≥ 0.6).

### Postman

Import [docs/postman/trip-war-room.postman_collection.json](docs/postman/trip-war-room.postman_collection.json)
and run it with the Collection Runner. Every request has assertions; folder 5
shows the server rejecting requests above the caller's role.

### Load test and API benchmark

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for results and the exact commands:

```bash
npm run dev:memory --prefix server -- --port 5090 --bench
```

```bash
npm run load-test --prefix server -- http://localhost:5090 8 2 25
```

```bash
npm run bench:api --prefix server -- http://localhost:5090 40
```

`--bench` lifts the rate limits for load testing only. Never use it on a real
deployment.

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

All six phases are done. Each has its own commit, so `git log` shows the
project's history phase by phase.

## Known limitations

- **One server process.** Rooms, the event bus and rate-limit counters live in
  memory. Scaling out needs Redis (see the architecture doc).
- **REST latency over a remote database.** It misses the 200 ms target from this
  laptop to a free-tier Atlas cluster, while meeting it easily with a local or
  same-region database.
- **The AI latency target wasn't measured with Claude** (no API credits at
  test time). The free local model is too slow on a CPU-only laptop.
- **No automated UI tests.** The client was verified in the browser, and all
  rules are enforced and tested on the server.
- **Touch screens:** drag and drop needs a mouse; on touch, change the day in
  the card dialog.
- **Data:** one hand-authored destination (Lisbon); prices and venues are
  fictional, and weather is mocked.
- **Hosting:** public deployment is out of scope per spec 4.2, but the repo is
  ready for Render (one service, see [docs/DEPLOY.md](docs/DEPLOY.md)). The free
  plan sleeps after 15 minutes idle.

## AI assistance

This project was built with help from an AI coding assistant (Claude), which
wrote much of the code and documentation under the author's direction. The
author planned the work phase by phase, approved the design, and reviewed the
results. Disclose this as your course's AI-use policy requires.
