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
