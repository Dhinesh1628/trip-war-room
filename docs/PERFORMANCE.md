# Performance: measured numbers (spec 10.2, 12.2)

Measured on 2026-11-19, on one laptop (Intel i7-1165G7, 4 cores, 12 GB RAM,
no dedicated GPU, Windows 11, Node 24). The server, the test clients and
(where noted) the database all ran on that one machine. The raw outputs are in
[results/](results/).

Two database setups were measured, to separate the cost of my code from the
cost of the network:
- **Local:** an in-memory MongoDB on the same machine (`dev:memory`).
- **Atlas:** a free-tier MongoDB Atlas cluster reached over the internet. A
  database round trip from this laptop measured **46 ms min, 59 ms median,
  68 ms P95** (25 pings).

## Summary against spec 10.2

| Dimension | Target | Local DB | Atlas DB | Verdict |
|---|---|---|---|---|
| Itinerary sync drift | < 100 ms | **P95 1 ms** (2 rooms × 8), **6 ms** (1 room × 50) | **P95 1 ms** | Met |
| WebSocket fan-out, last client | < 500 ms | **P95 1 ms** (2 × 8), **6 ms** (1 × 50) | **P95 1 ms** | Met |
| Concurrent rooms | no single-room assumption | 2 rooms in parallel; 50 travellers in one room | 2 rooms | Met |
| Non-AI API latency | P95 < 200 ms | **P95 ≤ 10 ms on every endpoint** | P95 110–383 ms; 3 of 10 endpoints met | Met locally; **missed over Atlas** (network-bound, see below) |
| AI Concierge latency | P95 < 3 s | template: P95 230 ms; local LLM: P95 14.8 s | same | Met with template; **missed with the local LLM**; Claude **not measured** |
| Conflict flag | within 1 s, 95% of cases | max 19 ms over 20 tries (automated test) | n/a | Met |
| Joiner snapshot | within 2 s | covered by test (< 2 s) | about 200 ms | Met |

## 1. Board sync (`npm run load-test`)

Scripted travellers join each room and run 25 rounds. In every round two
planners move the **same** card at the same moment, while everyone else pins
cards or chats at the same time.

| Run | Updates delivered | Sync drift P50 / P95 / max | Fan-out P95 | Ack P95 | Simultaneous moves | Boards agree |
|---|---|---|---|---|---|---|
| Local, 2 rooms × 8 | 1,616 | 0 / **1** / 2 ms | 1 ms | 61 ms | 50 rounds: 50 applied, 50 rejected | Yes |
| Local, 1 room × 50 | 31,300 | 2 / **6** / 17 ms | 6 ms | 1,865 ms | 25 rounds: 25 applied, 25 rejected | Yes |
| Atlas, 2 rooms × 4 | 408 | 0 / **1** / 2 ms | 1 ms | 13 ms | 50 rounds: 50 applied, 50 rejected | Yes |

- **Sync drift** is the time from the server sending an update to a client
  receiving it. **Fan-out** is the spread between the first and last client
  receiving the same update. Both are under 20 ms even with 50 people in one room.
- **Every simultaneous pair** produced exactly one applied move and one
  explicit rejection, and every client ended with an identical board (spec 6.1
  acceptance).
- Sync doesn't depend on the database. The board broadcasts first and saves
  in the background, so Atlas numbers match local ones.
- **Ack latency** is the time for your own action to be confirmed. It rises at
  50 people because of the test's extreme load: about 600 cards on one board,
  each change re-running the conflict detector and budget across the whole
  board, and 50 clients sharing the server's CPU on one laptop. The spec sets no
  target for it. A real 5-day board holds about 20–40 cards. The design target
  of 50 concurrent planners (spec 1.3) was met for sync and fan-out.

## 2. REST API (`npm run bench:api`)

40 sequential requests per endpoint after one warm-up; P50 / P95 in ms.

| Endpoint | Local P50 / P95 | Atlas P50 / P95 |
|---|---|---|
| `GET /health` | 1 / 2 | 1 / 2 |
| `GET /auth/me` | 5 / 6 | 120 / 383 |
| `GET /destinations/lisbon/venues?near=…` | 3 / 7 | 59 / 110 |
| `GET /trips/{id}` | 5 / 8 | 180 / 207 |
| `GET /trips` | 6 / 8 | 180 / 344 |
| `GET /trips/{id}/budget` | 5 / 8 | 195 / 318 |
| `GET /trips/{id}/recommendations` | 7 / 10 | 241 / 281 |
| `GET /trips/{id}/analytics` | 6 / 8 | 178 / 229 |
| `GET /users/me/dashboard` | 6 / 8 | 232 / 262 |
| `POST /auth/refresh` | 5 / 7 | 123 / 137 |

**Why Atlas misses the target.** Each request does 2–4 small database
operations in sequence: authenticate (re-reading the user's role on purpose,
see [SECURITY.md](SECURITY.md)), load the trip, then the related data. At about
60 ms per round trip to a distant free-tier cluster, three of them cost about
180 ms before any code runs, and the cluster's latency also varies: the same
endpoint measured 183 ms P95 in one run and 383 ms in the next. Locally, the
same code answers in 10 ms or less. In a normal deployment, the API server sits
in the same region as the database (round trips about 1 ms), and these
endpoints would land in the 10–30 ms range.

**What was optimised during Phase 6** (measured on Atlas, before → after):
- Venue search: P95 238 → 110 ms (the in-memory catalog cache removes two round
  trips; also used by rooms, the Concierge and recommendations).
- Token refresh: P95 281 → 137 ms (four sequential round trips → two).
- The WebSocket handshake had already gone from three sequential reads to one
  parallel batch in Phase 2 (joining went from about 2 s to about 200 ms).

**What wasn't done, and why.** Caching the user lookup in `requireAuth` would
save one round trip per request, but then removing someone's admin rights
would no longer take effect immediately. The security behaviour was kept.

## 3. AI Concierge (`npm run eval:concierge`)

12 fixed questions against the live server, end-to-end time as the client sees it.

| Answer source | Compliance | Median | P95 | Notes |
|---|---|---|---|---|
| Template (no model) | 11/11 | 197 ms | 230 ms | Same rule-checked suggestions, fixed wording |
| Local model, Ollama `llama3.2:3b` on the CPU | 11/11 | 10.2 s | **14.8 s** | All 11 worded by the model; misses the 3 s target on this hardware |
| Claude `claude-opus-5-5` | not measured | n/a | n/a | The API account had no credits when this was run; every call returned 400 and fell back to the template (that run: P95 1.8 s, all compliant) |

The spec's 3-second target is reachable in two ways that this machine couldn't
test: Claude with credits (a short prompt with the top 5 candidates, a short
reply, at low effort), or a local model on a GPU. The code enforces the target
anyway: Claude calls time out at 2.5 s and fall back to the grounded template,
so with Claude configured the end-to-end P95 is capped at about 2.6 s by design.

## 4. Other measured numbers

| What | Result | Source |
|---|---|---|
| Constraint compliance | 379 simulated requests, 0 violations; every rejected venue really fails a rule | `constraints.test.js` |
| Conflict flag delay | max 19 ms over 20 tries (target 1 s for 95%) | `concierge.test.js` |
| Recommendation Precision@5 | 0.735 mean over 5 seeds (target ≥ 0.6); popularity baseline 0.122 | `npm run eval:recs` |
| Budget accuracy | 2,000 random splits and 300 random trips exact to the cent; hand-worked trip matches | `budget.test.js` |
| Analytics reconciliation | hand-worked session reconciles exactly; live trip: 32 events replay to the stored board | `phase4.test.js`, analytics page |

## How to reproduce

```bash
npm run dev:memory --prefix server -- --port 5090 --bench
npm run load-test --prefix server -- http://localhost:5090 8 2 25
npm run load-test --prefix server -- http://localhost:5090 50 1 25
npm run bench:api --prefix server -- http://localhost:5090 40
npm run eval:concierge --prefix server
npm run eval:recs --prefix server
```

`--bench` lifts the sign-up rate limit so the load test can create accounts.
Against a normal server, keep runs under 20 new accounts per 15 minutes (for
example 2 rooms × 4). Run measurements with a server that is not in watch mode
(`npm start`, or `node --env-file=.env src/server.js`), because file watching
restarts the dev server when files change.
