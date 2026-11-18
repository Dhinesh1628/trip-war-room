# Decisions and deviations from the spec

The spec (section 13.2) asks for every deviation to be written down with the
reason. Newest phase last.

## Phase 0

**Stack and track.** Track A (full-stack), Option B (MERN): MongoDB with
Mongoose, Express 5, Socket.io 4, React 19 with Vite, plain JavaScript
(ES modules), Jest and Supertest.

**One process, two modules.** The REST API (`src/app.js`) and the Board Sync
Gateway (`src/realtime/`) share one HTTP server and one pooled Mongoose
connection (spec 9.2), but neither imports the other, so they could be split
later (spec 9.4).

**Port 5080, not 5060.** 5060 is the SIP port and is on the browser and
`fetch` "unsafe ports" list, so browsers refuse to connect to it. Ports 5000,
5050, 5173 and 5174 were already used by other projects on the dev machine.

**`dev:memory` mode.** Runs the server on an in-memory MongoDB with the
datasets pre-loaded, so a reviewer can try the app without any database setup.

## Phase 1

**Roles are split into an account role and a trip role.** The spec's reference
schema puts one `role` on the user. But a person can lead one trip and only view
another, so:
- `users.role` is `user` or `admin` (Admin manages venue datasets).
- Each trip's `participants[]` entry has a role of `viewer`, `planner` or `leader`.
- The effective role in a trip is `admin` for admins, otherwise the participant
  role. Ranking is Viewer < Planner < Leader < Admin, so all four tiers in the
  spec still exist and are enforced server-side (`src/auth/roles.js`,
  `src/trips/access.js`), and the WebSocket gateway will reuse the same functions.

**Every request re-reads the user's role.** The JWT proves who you are, but
`requireAuth` loads the current role from the database. Removing someone's
admin rights or deleting their account therefore works immediately rather than
when the token expires. It costs one indexed lookup per request.

**Refresh tokens.** Access tokens are JWTs that last 15 minutes (the config
refuses anything over 1 hour). Refresh tokens are random strings in an httpOnly,
SameSite=Strict cookie scoped to `/api/v1/auth`. Only their SHA-256 hash is
stored. Every refresh rotates the token, and re-using an old one revokes the
whole session (theft detection).

**IDs.** MongoDB ObjectIds are used for users and trips instead of the spec's
illustrative `tr_44210` / `u_501`. Venues use the dataset's own id
(`v_lis_001`) as `_id`, so AI citations (Phase 3) point at a stable,
human-readable id.

**Dates are `YYYY-MM-DD` strings.** A trip day is a calendar day at the
destination; storing UTC timestamps would invite off-by-one-day bugs.

**Money.** All prices are USD (the spec's examples use "$"), stored as numbers
with at most 2 decimals. The budget engine (Phase 4) will do its arithmetic in
integer cents so totals are exact. Lodging `pricePerPerson` means per person
per night.

**Prices must be positive.** The spec says the upload must check that price is
a positive number, so even nearly-free activities have a small price (for
example a $5 map fee) instead of 0.

**A trip's destination must have a dataset.** Creating a trip for a city with no
venue data is rejected, because the Concierge could not work there.

**Proximity search.** A lat/lng bounding box narrows the query using the
`(destination, lat, lng)` compound index from spec 9.2, then an exact haversine
check removes the corners of the box. This was chosen over a MongoDB `2dsphere`
index because it follows the spec's index guidance and is easy to verify by hand.

**The admin dataset upload endpoint was built early.** Spec 6.3 places it in
Epic 3, but the validator is needed now for the seed data, and having an
Admin-only route lets the RBAC tests cover all four roles from Phase 1. The
upload UI comes in Phase 4.

**The dataset is fictional but realistic.** Venue names, prices, hours and
ratings are invented; the neighbourhoods and coordinates are real Lisbon
locations. It deliberately includes every dietary tag, venues over budget,
venues with short or past-midnight hours, and lodging from $38 to $215 a night,
so every constraint rule can be tested (spec 14.1).

## Phase 2

**One namespace, one connection per room.** Clients connect to `/trips` with
`auth: { token, tripId }`. The handshake is the only way into a room, and
it applies the same JWT check and membership rule as the REST API (spec 7.3.4,
10.1).

**The board is authoritative in memory; the database is written behind it**
(spec 9.4). Each open room keeps its items in a `Map`. A change is checked and
applied synchronously, then broadcast, then saved:
- pins, removes, locks and unlocks are saved immediately;
- moves are batched and saved at most every 250 ms (`FLUSH_INTERVAL_MS`).

Saves are whole-document upserts, queued through one promise chain per room, so
they land in order and a retry after a failure is always safe. Broadcasting
before saving keeps sync drift in single-digit milliseconds even on a slow
database link; the trade-off is that a crash in that window could lose the most
recent change, which is acceptable for a planning board. When the last
traveller leaves, the room is saved and unloaded, and it reloads from MongoDB on
the next join.

**Concurrent moves: first valid write wins, the other is told.** Every item has
a `positionVersion`, and a move must quote the version it last saw. The check
and the update happen in one synchronous step (Node runs one handler at a time),
so two moves can never both pass. The spec describes this as "last-write-wins
with a server-assigned version": the server's arrival order decides, and the
stale write is refused instead of silently overwriting. The loser gets
`VERSION_CONFLICT` with the current item in its ack and a `trip.board.rejected`
event (spec 6.1). No database locks are used (spec 9.4).

**Leader disconnected: freeze, don't promote.** Spec 6.1 allows either choice.
Freezing was chosen because it is simpler to reason about and cannot hand
control to someone the leader didn't pick. After the presence grace period,
`trip.leader.status` says `connected: false` and lock/unlock are refused with
`LEADER_DISCONNECTED`, even for Admins, so the behaviour is deterministic.
Everything else (pinning, moving, chat) carries on. The leader can hand over
deliberately with `trip.mod.transferLeader`.

**Reconnects inside a grace window are invisible.** A traveller is only
announced as `left` after their last connection has been gone for
`PRESENCE_GRACE_MS` (default 5 s). Reconnecting sooner produces no `left` and no
second `joined` (spec 10.3), and the new connection gets a full snapshot,
including the last 50 chat messages. Several tabs for one person count once.

**Role checks: cached for speed, re-read for sensitive actions.** Pin, move and
chat check the role from the room's copy of the trip, so they don't wait on a
database read (that would add a full Atlas round trip to every move). The copy
stays current because the REST API announces changes (join, role change,
settings) on an in-process event bus, and the gateway reloads the trip.
Sensitive actions (lock, unlock and all moderation) also check that the access
token hasn't expired and re-read the account and trip from the database
(spec 10.1). A long-lived socket can swap in a new token with `auth.renew`.

**"Lock room" means "closed to new travellers".** The spec doesn't define it
further. Locking the board itself is already covered by per-item locks.

**Mute blocks chat and typing only.** A muted planner can still plan; muting is
for the chat channel.

**Chat is plain text.** The server strips HTML tags and invisible control
characters before saving (spec 10.1, stored XSS), and the client will render
chat as text. Reactions are limited to six fixed emoji, so they cannot carry
arbitrary text. `clientMsgId` makes resending after a reconnect safe.

**Single-process limitation.** Room state and the event bus live in one Node
process. Running several server instances would need the Socket.io Redis
adapter, a shared pub/sub in place of the bus, and sticky sessions or a shared
room store. Nothing assumes a single *room*, though: rooms are independent and
there is a test that two rooms never see each other's events (spec 10.2).

**Latency on Atlas.** The first version of the handshake made three database
reads one after another, so joining took about 2 s on this network. The reads
now run in parallel, and joining takes about 200 ms. The room's own operations
(pin, move, lock broadcast) do not wait on the database at all.

**Budget totals are a placeholder until Phase 4.** The live panel currently
assumes everyone attends everything (an even split), computed in integer cents.
Phase 4 replaces it with the full engine (weighted splits, per-person totals).
