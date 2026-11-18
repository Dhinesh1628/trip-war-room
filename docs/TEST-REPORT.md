# Test report (spec 12.1, 12.2)

**Result: 351 tests in 16 files, all passing** (run on 2026-11-19, 82 s,
Node 24, Jest 30). Each test file starts its own in-memory MongoDB, so no
setup is needed:

```bash
npm test
```

This runs the server suite and then builds the client.

## What is covered

The spec's required areas (12.1: board state machine, constraint matching,
budget math, access control) are in bold.

| File | Tests | What it proves |
|---|---|---|
| **`boardState.test.js`** | 24 | **Board state machine** on its own: pin, move, remove, lock, unlock; version checks (first valid write wins, stale writes change nothing, 50 stale moves in any order); slot validation; chat cleaning |
| **`realtime.test.js`** | 44 | The board with real Socket.io clients: handshake auth (4 refusal cases), snapshots within 2 s, sync under 100 ms, **20 rounds of simultaneous moves where everyone agrees and the database matches**, locks, token expiry and renewal, leader disconnected state, presence, reconnects, room isolation, chat, moderation |
| **`constraints.test.js`** | 27 | **Constraint matching**: 379 simulated requests checked against an independent re-implementation of the four rules (0 violations, and no valid venue wrongly rejected); opening hours past midnight; the 40/30/30 ranking |
| `concierge.unit.test.js` | 42 | Reading questions, building constraints, the grounding check (invented prices, times, venues, walking minutes), the Claude call with a fake client (request shape and every fallback), the conflict detector, vote rules |
| `concierge.test.js` | 16 | End to end: the spec's example question over REST and WebSocket, room broadcast, declines, rate limit, **conflicts flagged within 1 s in 20 of 20 tries**, budget breaches (including one that grows), votes resolving identically for all clients and surviving a reload |
| `ollama.test.js` | 19 | The free local-model path against a fake Ollama server; quality check; time limits |
| **`budget.test.js`** | 15 | **Budget math**: hand-worked splits and a hand-worked trip; 2,000 random splits and 300 random trips that must add up exactly to the cent |
| `phase4.test.js` | 11 | Attendance and weighted splits (exact cents), budget-split votes, **a hand-worked session whose analytics must reconcile exactly with the event log**, recommendations, the dashboard |
| `recs.test.js` | 9 | Content-based and collaborative parts, the co-traveller boost, cold start, group filters, **Precision@5 ≥ 0.6** |
| **`rbac.test.js`** | 38 | **Access control**: every protected action tried by outsider, Viewer, Planner, Leader and Admin (30 cases), no token, instant role revocation, who sees invite codes |
| `auth.test.js` | 23 | Register and login, token expiry, forgery, the `none` algorithm, deleted accounts, refresh rotation, reuse detection, a refresh race, hashed storage, logout, preferences, rate limiting |
| `trips.test.js` | 24 | Trip creation and validation, invite codes, joining, capacity (5 people racing for the last seat), **invite brute-force limit**, listing and settings |
| `venues.test.js` | 17 | Distance maths, proximity search compared with a brute-force calculation, query validation |
| `dataset.test.js` | 33 | The Lisbon data covers every constraint type; 16 kinds of bad upload rejected with clear messages; re-loading; the admin upload endpoint |
| `health.test.js` | 7 | Health checks and config safety (missing or short secrets, token lifetime cap) |
| `gateway.test.js` | 2 | WebSocket ping/pong and connection counting |

## Spec acceptance criteria → evidence

| Criterion | Evidence |
|---|---|
| 6.1 Pin/move/lock reflected on all clients within 100 ms | `realtime.test.js` "a pin reaches every client identically, well inside 100 ms"; load test P95 1–6 ms ([PERFORMANCE.md](PERFORMANCE.md)) |
| 6.1 Simultaneous moves never leave server and client disagreeing; the loser is told | `realtime.test.js` 20 rounds; load test 125 rounds across runs |
| 6.1 Mid-session joiner gets full state within 2 s | `realtime.test.js` "a participant joining mid-session…" |
| 6.1 Leader disconnect is deterministic and tested | `realtime.test.js` "leader disconnected state" (2 tests) |
| 6.2 100% constraint compliance across ≥ 20 requests | `constraints.test.js`: 379 requests |
| 6.2 Answers cite metadata and never invent venues, prices or hours | `concierge.unit.test.js` grounding tests; `concierge.test.js` "if Claude invents a price…" |
| 6.2 Conflicts flagged within 1 s in ≥ 95% of cases | `concierge.test.js`: 20 of 20, max 19 ms |
| 6.2 Vote result applied identically and simultaneously | `concierge.test.js` "…the result is identical for all" |
| 6.3 Recommendations update without a retrain cycle | `phase4.test.js` "a new like updates the rail…" |
| 6.3 Analytics reconcile exactly with the event log | `phase4.test.js` "a manually verified session" |
| 6.3 Upload validates price, tags, coordinates, hours | `dataset.test.js` (16 rejection cases) |
| 10.1 RBAC enforced server-side across all four roles | `rbac.test.js`, `realtime.test.js` |
| 10.1 WebSocket auth at handshake; re-validated on sensitive actions | `realtime.test.js` handshake and token-expiry tests |
| 10.1 Input validated; no stored XSS in chat | `boardState.test.js` cleaning cases; `realtime.test.js` chat tests |
| 13 Budget engine 100% accurate | `budget.test.js`, `phase4.test.js` |

## Outside the automated suite

These were checked by running scripts against a live server (outputs in
[results/](results/)) and in the browser:

- load tests (2 × 8, 1 × 50 locally; 2 × 4 on Atlas), the REST benchmark, and
  the Concierge evaluation (see [PERFORMANCE.md](PERFORMANCE.md));
- the Precision@5 evaluation over 5 seeds: `npm run eval:recs`;
- the full UI in a real browser, in light mode, dark mode and at 375 px, with
  two scripted travellers live in the same room (Phase 5).

**Timing sensitivity:** a few tests assert real-time limits (for example "every
client within 100 ms"). In one run out of about ten, made while three servers
and a client build were competing for the laptop's CPU, one test failed and
then passed on every re-run. On a busy machine, re-run before treating a single
failure in `realtime.test.js` or `concierge.test.js` as a regression.

**Not covered:** there are no automated tests for the React client. Its
behaviour was verified in the browser, and every rule it relies on is enforced
and tested on the server. A Playwright end-to-end suite is the next step
listed in the [retrospective](RETROSPECTIVE.md).
