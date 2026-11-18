# API reference

Base URL: `http://localhost:5080/api/v1`. All bodies are JSON.
WebSocket events: see [Real-time (WebSocket) API](#real-time-websocket-api) below.

**Authentication.** Send `Authorization: Bearer <accessToken>` on every route
marked *auth*. Access tokens last 15 minutes (configurable, max 1 hour). When
one expires the API answers `401` with code `TOKEN_EXPIRED`; call
`POST /auth/refresh` to get a new one.

**Errors** always look like this:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Request is invalid",
             "details": [{ "path": "endDate", "message": "endDate cannot be before startDate" }] } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED` (with `details`), `BAD_JSON` |
| 401 | `UNAUTHORIZED`, `TOKEN_EXPIRED`, `INVALID_TOKEN`, `BAD_CREDENTIALS`, `REFRESH_MISSING`, `REFRESH_INVALID`, `REFRESH_EXPIRED`, `REFRESH_REUSED` |
| 403 | `FORBIDDEN` (role too low, or not a participant) |
| 404 | `NOT_FOUND` |
| 403 | `ROOM_LOCKED` (join refused: the leader locked the room) |
| 409 | `EMAIL_TAKEN`, `ROOM_FULL` |
| 413 | `TOO_LARGE` (body over 1 MB) |
| 429 | `RATE_LIMITED` (register/login: 20 per 15 min per IP) |

## Roles

| Role | Kind | Can |
|---|---|---|
| Viewer | per trip | read the trip |
| Planner | per trip | Viewer + pin/move/vote (Phase 2) |
| Leader | per trip | Planner + room settings, participant roles, invite code, locks (Phase 2) |
| Admin | account | everything in every trip + venue dataset management |

---

## Health

### `GET /health`
`200 { "status": "ok", "db": "connected" }`, or `503` with `"status": "degraded"` if the database is down.

### `GET /health/gateway`
`200 { "status": "ok", "connectedClients": 3, "uptimeSeconds": 120 }`

## Auth

### `POST /auth/register`
```json
{ "email": "maya@example.com", "password": "at least 8 chars", "displayName": "Maya" }
```
`201`:
```json
{ "accessToken": "eyJ...", "expiresIn": 900,
  "user": { "id": "6745...", "email": "maya@example.com", "displayName": "Maya", "role": "user",
            "preferences": { "dietaryTags": [], "budgetCeiling": null }, "createdAt": "..." } }
```
Also sets the `twr_refresh` cookie (httpOnly, SameSite=Strict, path `/api/v1/auth`, 7 days).
Errors: `400`, `409 EMAIL_TAKEN`, `429`.

### `POST /auth/login`
`{ "email", "password" }` → `200`, same shape as register. A wrong password and
an unknown email both return `401 BAD_CREDENTIALS`.

### `POST /auth/refresh`
No body; uses the refresh cookie. `200` with a new `accessToken` and a **new**
cookie (the old one is now dead). Re-using an old refresh token returns
`401 REFRESH_REUSED` and logs out every device in that session.

### `POST /auth/logout`
Revokes the refresh token's session and clears the cookie. `204`.

### `GET /auth/me` *(auth)*
`200 { "user": { ... } }`

## Users

### `PATCH /users/me` *(auth)*
```json
{ "displayName": "Maya R.", "preferences": { "dietaryTags": ["vegetarian"], "budgetCeiling": 40 } }
```
All fields optional. `dietaryTags` must come from the vocabulary:
`vegetarian, vegan, halal, kosher, gluten-free, dairy-free, nut-free`.
`budgetCeiling` is the most this traveller wants to spend on the trip's
itinerary in total (USD, per person), or `null`. The conflict detector flags a
`budgetBreach` when the board pushes them past it, and the Concierge uses the
traveller's remaining headroom as their price ceiling. `role` cannot be set
here (`400`). Every open Trip Room the traveller is in picks up the change
immediately.

## Destinations and venues *(auth)*

### `GET /destinations`
```json
{ "destinations": [ { "slug": "lisbon", "name": "Lisbon, Portugal", "country": "Portugal",
    "center": { "lat": 38.711, "lng": -9.1366 }, "venueCount": 42, "datasetVersion": "lisbon-2026.11-1" } ] }
```

### `GET /destinations/{destination}`
`{destination}` is the slug (`lisbon`) or the name (`Lisbon%2C%20Portugal`).
Returns identity plus `transit` (neighbourhood-to-neighbourhood links with mode,
minutes and cost) and `weather` (`monthly` normals and a `daily` forecast).

### `GET /destinations/{destination}/venues?near={lat,lng}&radiusKm={n}&category={c}`
Spec 7.3.2. All query parameters are optional. With `near`, only venues within
`radiusKm` (default 2, max 50) are returned, nearest first, with `distanceKm`.
`category` is one of `breakfast, lunch, dinner, cafe, bar, activity, tour, museum, attraction, lodging`.

```json
{ "destination": "Lisbon, Portugal", "slug": "lisbon",
  "near": { "lat": 38.7118, "lng": -9.1296 }, "radiusKm": 1, "count": 17,
  "venues": [
    { "venueId": "v_lis_025", "name": "Alfama Old Quarter Walking Tour", "category": "tour",
      "neighborhood": "Alfama", "pricePerPerson": 25, "dietaryTags": [],
      "hours": { "open": "10:00", "close": "19:00" },
      "coordinates": { "lat": 38.7118, "lng": -9.1296 },
      "rating": 4.7, "reviewCount": 1450, "indoor": false,
      "description": "...", "distanceKm": 0 } ] }
```
Prices are USD per person (lodging: per person per night). If `close` is
earlier than `open`, the venue is open past midnight.

### `GET /destinations/{destination}/venues/{venueId}`
`200 { "destination": "Lisbon, Portugal", "venue": { ... } }`

### `POST /destinations/{destination}/venues/{venueId}/feedback`
`{ "liked": true }` → `201 { "venueId", "liked" }`. An explicit like or dislike,
which the recommendations count twice as strongly as a pin.

### `GET /users/me/dashboard` *(auth)*
The personal dashboard (spec 6.3).

```json
{ "user": { "userId": "...", "displayName": "Sam" },
  "trips": { "led": [ ], "joined": [ { "tripId": "...", "destination": "Lisbon, Portugal", "startDate": "...", "endDate": "...",
                                       "status": "drafting", "myRole": "planner", "participantCount": 3, "onlineNow": 2 } ] },
  "activeRooms": [ { "tripId": "...", "onlineNow": 2, "...": "same fields" } ],
  "preferenceProfile": {
    "declared": { "dietaryTags": ["vegan"], "budgetCeiling": 300 },
    "fromHistory": { "signals": 12, "favouriteCategories": [ { "name": "dinner", "count": 5 } ],
                     "dietaryTagsOfLikedPlaces": [ { "name": "vegan", "count": 4 } ],
                     "priceRange": { "min": 9, "median": 18, "max": 48, "currency": "USD" } } },
  "recommendations": [ ], "recommendationsFor": "Lisbon, Portugal" }
```

`activeRooms` lists trips with someone online right now, for a quick rejoin.
`fromHistory` is built from what this traveller actually did: pins, votes,
removes and likes.

## Trips *(auth)*

### `POST /trips`
Spec 7.3.1. The caller becomes the Leader.
```json
{ "destination": "Lisbon, Portugal", "startDate": "2026-12-10", "endDate": "2026-12-14",
  "totalBudget": 1200, "maxParticipants": 8, "defaultJoinRole": "planner" }
```
`maxParticipants` (1–50, default 8) and `defaultJoinRole` (`planner`|`viewer`,
default `planner`) are optional. Trips can be at most 30 days. The destination
must have a loaded venue dataset.

`201`:
```json
{ "tripId": "6745b1...", "inviteCode": "AB-7Q2K", "inviteUrl": "http://localhost:5180/join/AB-7Q2K",
  "status": "drafting", "leaderUserId": "6745a0...", "createdAt": "2026-11-18T10:15:00.000Z",
  "trip": { ...trip view... } }
```

**Trip view** (returned by every trip route):
```json
{ "tripId": "...", "destination": "Lisbon, Portugal", "destinationSlug": "lisbon",
  "startDate": "2026-12-10", "endDate": "2026-12-14", "dayCount": 5,
  "totalBudget": 1200, "currency": "USD", "status": "drafting", "leaderUserId": "...",
  "myRole": "leader", "inviteCode": "AB-7Q2K", "inviteUrl": "...",
  "participants": [ { "userId": "...", "displayName": "Maya", "role": "leader", "joinedAt": "..." } ],
  "participantCount": 1,
  "settings": { "maxParticipants": 8, "defaultJoinRole": "planner", "aiVerbosity": "concise" },
  "createdAt": "...", "updatedAt": "..." }
```
`inviteCode` and `inviteUrl` are only included for Leaders and Admins.

### `GET /trips`
Trips I lead or joined, newest first: `{ "trips": [ ... ] }`.

### `GET /trips/{id}` — Viewer+
`{ "trip": { ... } }`. `403` if you are not a participant.

### `GET /trips/invite/{code}`
Preview before joining. The code is case-insensitive and the dash is optional.
```json
{ "tripId": "...", "destination": "Lisbon, Portugal", "startDate": "2026-12-10", "endDate": "2026-12-14",
  "leaderName": "Maya", "participantCount": 3, "maxParticipants": 8, "joinRole": "planner", "alreadyJoined": false }
```

### `POST /trips/join`
`{ "inviteCode": "AB-7Q2K" }` → `201 { "joined": true, "alreadyMember": false, "trip": {...} }`.
Joining again returns `200` with `alreadyMember: true`. `404` for an unknown
code, `409 ROOM_FULL` when the room is at capacity. The capacity check is atomic,
so two people can never both take the last seat.

### `PATCH /trips/{id}/participants/{userId}` — Leader+
`{ "role": "viewer" }` (or `"planner"`). The leader's own role cannot be changed here.

### `PATCH /trips/{id}/settings` — Leader+
Any of `{ "maxParticipants": 10, "defaultJoinRole": "viewer", "aiVerbosity": "detailed" }`.
`maxParticipants` cannot go below the current headcount.

### `POST /trips/{id}/ai/ask` — Viewer+ (spec 7.3.3)

Asks the AI Concierge. Only `question` is required. The other fields override
what is read from the question text. A `userId` in the body is accepted for
compatibility with the spec's example, but ignored: the caller is always the
token's owner.

```json
{ "question": "Suggest a dinner spot near our 5 PM tour under $25/person",
  "anchorItemId": "6745c2...", "category": "dinner", "maxPricePerPerson": 25,
  "dietaryTags": ["vegetarian"], "time": "19:30", "dayIndex": 0, "radiusKm": 2 }
```

`200`, with the spec's fields first (the numbers here are examples):

```json
{ "answer": "Taberna da Rua is a 1-minute walk from Alfama Old Quarter Walking Tour, has vegetarian options, costs about $22 per person, and is open 11:00-22:00. Other options: Horta Verde ($18) and Petiscos do Castelo ($24).",
  "suggestedVenueId": "v_lis_001",
  "sourceEvents": ["venue:v_lis_001", "venue:v_lis_002", "venue:v_lis_017", "item:6745c2...", "weather:2026-12-10"],
  "generatedAt": "2026-11-18T17:50:02.114Z",

  "questionId": "6745d0...", "tripId": "...", "userId": "...", "question": "...",
  "sources": [ { "venueId": "v_lis_001", "name": "Taberna da Rua", "category": "dinner", "pricePerPerson": 22,
                 "dietaryTags": ["vegetarian"], "hours": { "open": "11:00", "close": "22:00" },
                 "coordinates": { "lat": 38.7121, "lng": -9.1302 }, "distanceKm": 0.042, "walkMinutes": 1 } ],
  "weather": { "date": "2026-12-10", "source": "forecast", "condition": "sunny", "highC": 17, "lowC": 10, "precipitationChance": 5 },
  "constraints": {
    "active": { "budget": true, "dietary": false, "hours": true, "proximity": true },
    "category": "dinner", "maxPricePerPerson": 25, "budgetSource": "question", "dietaryTags": [],
    "mustBeOpen": { "from": "19:30", "to": "21:00", "reason": "30 min after Alfama Old Quarter Walking Tour ends" },
    "anchor": { "itemId": "...", "venueId": "v_lis_025", "name": "Alfama Old Quarter Walking Tour", "coordinates": { }, "dayIndex": 0, "startTime": "17:00", "endTime": "19:00" },
    "radiusKm": 2, "notes": [] },
  "candidates": [ { "venueId": "v_lis_001", "name": "Taberna da Rua", "pricePerPerson": 22, "distanceKm": 0.042, "score": 0.553,
                    "scores": { "proximity": 0.979, "rating": 0.758, "headroom": 0.12 } } ],
  "validCount": 9, "rejectedCount": 33, "nearMisses": [],
  "mode": "llm", "model": "claude-opus-5-5", "latencyMs": 1840 }
```

- `mode` is `llm` (Claude wrote the wording), `template` (a fixed sentence
  built from the same facts; `fallbackReason` says why: `no_api_key`,
  `timeout`, `refusal`, `ungrounded`, `schema_mismatch`, `invalid_json`,
  `max_tokens`, `rate_limited`, `bad_api_key`, `api_error_<status>`), or
  `no_match` (nothing passed every rule: `suggestedVenueId` is `null`, and
  the answer and `nearMisses` say which rules ruled the closest venues out).
- The answer is also broadcast to the room as `trip.ai.suggestion` and saved
  in the chat as an `ai_answer` message.
- Errors: `400` (question under 3 or over 500 characters, bad field),
  `403` (not a participant), `404` (`anchorItemId` not on the board),
  `429 RATE_LIMITED` (20 questions per traveller per minute).

How the hard rules work (spec 6.2):

| Rule | Active when | Passes when |
|---|---|---|
| Budget | a price is in the question, or the asker/group has budget left | `pricePerPerson` ≤ ceiling. Ceiling: the question's price, else the asker's remaining `budgetCeiling`, else the group's remaining budget per person |
| Dietary | someone in the trip declared a tag, or the question names one | (food venues only) the venue has **every** tag |
| Hours | the question names a time, or there is an anchor | the venue is open for the whole visit: from the asked time, or 30 min after the anchor ends (30 min before it starts for "before"), for a category-based length (dinner 90 min, lunch 60, breakfast 45, ...) |
| Proximity | the question refers to a pinned item ("near our 5 PM tour", "after the castle"), or `anchorItemId` is sent | within `radiusKm` (default 2 km, or "within 500 m") of the anchor |

Ranking of the venues that pass: 40% proximity (1 at the anchor, 0 at the
radius), 30% rating/popularity (75% rating, 25% log review count), 30% budget
headroom (margin under the ceiling). Ties go to the lower venue id.
Venues already on the board are not suggested again.

### `GET /trips/{id}/budget` — Viewer+

The full breakdown from the budget engine. All arithmetic is in whole cents. Each item's
shares add up to exactly its cost, and the people's totals add up to exactly
the group total.

```json
{ "currency": "USD", "totalBudget": 1000, "groupTotal": 107, "remaining": 893, "overBudget": false,
  "perPerson": [ { "userId": "...", "displayName": "Maya", "committed": 51.5, "ceiling": 200, "remaining": 148.5, "overCeiling": false } ],
  "items": [ { "itemId": "...", "name": "Taberna da Rua", "dayIndex": 0, "startTime": "19:00",
               "split": "even", "attendees": ["<maya>", "<sam>"], "total": 44,
               "shares": { "<maya>": 22, "<sam>": 22 },
               "runningTotals": { "<maya>": 22, "<sam>": 22, "<priya>": 0 } } ] }
```

How costs work: an item costs `pricePerPerson × attendees`. With an `even` split
everyone attending pays the same; with `weighted` they pay in proportion to
whole-number weights (0–100). Leftover cents from rounding go to whoever has the
largest remainder (ties: lower user id), so nobody is ever more than one cent
from their exact share. `runningTotals` is each person's total after that item,
in board order.

### `GET /trips/{id}/analytics` — Viewer+ (spec 6.3)

Session analytics, computed **only from the trip's event log**. The final board
is rebuilt by replaying the log, and `reconciliation` compares that replay with
the stored board.

```json
{ "tripId": "...", "destination": "Lisbon, Portugal", "eventCount": 23,
  "planning": { "firstEventAt": "...", "lastEventAt": "...", "durationMinutes": 4.2 },
  "peakConcurrentPlanners": 3,
  "board": { "pinned": 3, "moved": 1, "removed": 0, "locked": 1, "finalItemCount": 3 },
  "concierge": { "questions": 2, "byMode": { "llm": 2 } },
  "conflicts": { "flagged": 1, "resolved": 1, "stillOpen": 0, "byType": { "overlap": 1 } },
  "votes": { "opened": 1, "resolved": 1, "cancelled": 0, "ballots": 3, "byKind": { "split": 1 } },
  "chatMessages": 1,
  "finalBudget": { "currency": "USD", "totalBudget": 1000, "groupTotal": 107, "remaining": 893,
                   "perPerson": [ { "userId": "...", "displayName": "Maya", "total": 51.5 } ],
                   "items": [ { "itemId": "...", "name": "...", "split": "weighted", "total": 51, "shares": { } } ] },
  "reconciliation": { "reconciled": true, "differences": [] } }
```

`durationMinutes` runs from the first logged event to the last. `peakConcurrentPlanners`
is the most travellers online at once, taken from the presence events.

### `GET /trips/{id}/recommendations?limit=5` — Viewer+ (spec 6.3)

"Recommended for your group". Venues already on the board are skipped, and
food venues must carry every dietary tag the group has declared.

```json
{ "tripId": "...", "destination": "Lisbon, Portugal", "groupDietaryTags": ["vegan"],
  "recommendations": [ { "venueId": "v_lis_017", "name": "Petiscos do Castelo", "category": "dinner",
                         "neighborhood": "Alfama", "pricePerPerson": 24, "dietaryTags": ["vegetarian", "nut-free"],
                         "rating": 4.5, "score": 0.612, "why": "liked by people you have travelled with" } ],
  "model": { "type": "hybrid content + collaborative", "alpha": 0.5, "interactions": 1734, "travellers": 122, "builtAt": "..." } }
```

`why` is one of: "you like museums" (or another category), "matches your vegan
picks", "fits your usual budget spending", "in Alfama, an area you like",
"liked by travellers with similar taste", "liked by people you have travelled
with", or "popular with visitors" (no history yet).

### `POST /trips/{id}/invite-code` — Leader+
Replaces the invite code; the old one stops working. `200 { "inviteCode", "inviteUrl" }`.

## Admin *(auth, Admin only)*

### `GET /admin/datasets`
`{ "datasets": [ { "slug", "name", "datasetVersion", "venueCount", "updatedAt" } ] }`

### `POST /admin/datasets/validate`
Body: a dataset (see [the Lisbon file](../server/data/destinations/lisbon.json)).
Checks it without saving: `200 { "valid": true, "destination": "lisbon", "venues": 42 }`
or `400` listing every problem.

### `POST /admin/datasets`
Validates and loads a dataset, replacing that destination's venues.
`201 { "summary": { "destination": "lisbon", "datasetVersion": "...", "venues": 42,
"inserted": 0, "updated": 1, "removed": 0, "transitLinks": 16, "weatherDays": 9 } }`.
Nothing is changed if validation fails.

**Dataset rules:** price is a positive number with at most 2 decimals; dietary
tags come from the vocabulary above; latitude −90..90 and longitude −180..180,
within 60 km of the destination centre (this catches swapped lat/lng); hours are
`HH:MM` from `00:00` to `23:59`, open ≠ close; venueIds look like `v_lis_001`
and are unique; unknown fields are rejected; currency must be `USD`.

---

## Real-time (WebSocket) API

Socket.io 4, namespace `/trips`. **One connection = one traveller in one Trip Room.**

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:5080/trips', { auth: { token: accessToken, tripId } });
```

The handshake checks the JWT and trip membership using the same rules as the
REST API. A refused connection fires `connect_error` with
`err.data = { code, status }`, where code is `UNAUTHORIZED`, `INVALID_TOKEN`,
`TOKEN_EXPIRED`, `FORBIDDEN` (not a participant, or removed) or `NOT_FOUND`.

### Envelope

Every message in both directions has this shape (spec 7.3.4):

```json
{ "event": "trip.board.update", "tripId": "6745b1...", "payload": { }, "ts": 1795019500180 }
```

On server messages, `ts` is the server's send time (ms since epoch). Clients may
send only the payload, but the envelope is recommended.

### Requests and acknowledgements

Every client → server event except `trip.sync.ping` takes a Socket.io
acknowledgement callback, which answers:

```json
{ "ok": true, "...": "result fields" }
{ "ok": false, "error": { "code": "VERSION_CONFLICT", "message": "...", "details": [] }, "current": { "...": "item" } }
```

```js
const res = await socket.timeout(5000).emitWithAck('trip.board.move', {
  event: 'trip.board.move', tripId,
  payload: { itemId, dayIndex: 1, startTime: '19:00', endTime: '20:30', expectedVersion: 3 },
});
```

The server also broadcasts the result to the whole room, **sender included**, so
every client can keep its board up to date from broadcasts alone.

Error codes: `VALIDATION_FAILED`, `FORBIDDEN`, `MUTED`, `LEADER_DISCONNECTED`,
`TOKEN_EXPIRED`, `NOT_FOUND`, `ITEM_NOT_FOUND`, `VERSION_CONFLICT`,
`ITEM_LOCKED`, `ITEM_IN_VOTE`, `ITEM_NOT_LOCKED`, `BAD_SLOT`, `ROOM_CLOSED`,
`VOTE_NOT_FOUND`, `VOTE_CLOSED`, `VOTE_NEEDS_TWO`, `VOTE_TOO_MANY`,
`NOT_CONTESTED`, `NOT_A_CANDIDATE`, `RATE_LIMITED`, `INTERNAL`.

### Item shape

```json
{ "itemId": "6745c2...", "venueId": "v_lis_001",
  "venue": { "name": "Taberna da Rua", "category": "dinner", "neighborhood": "Alfama", "pricePerPerson": 22,
             "coordinates": { "lat": 38.7121, "lng": -9.1302 }, "hours": { "open": "11:00", "close": "22:00" },
             "dietaryTags": ["vegetarian"] },
  "dayIndex": 0, "startTime": "17:30", "endTime": "19:00",
  "lifecycleStage": "drafting", "positionVersion": 1,
  "pinnedByUserId": "...", "lockedByUserId": null, "updatedAt": "..." }
```

`dayIndex` 0 is the first day of the trip. Times are `HH:MM`, and an item ends
on the same day it starts. `venue` is a snapshot taken when the item was pinned.
Lifecycle: `drafting` → `locked` (Leader) → `drafting` (Leader override), and
`drafting` → `voting` (a contested-slot vote) → `locked` for the winner, while
the losing options are removed (or back to `drafting` if the vote is
cancelled). An item in a vote cannot be moved, removed or locked.

### Client → server

| Event | Min role | Payload | Ack result |
|---|---|---|---|
| `trip.board.pin` | Planner | `{ venueId, dayIndex, startTime, endTime }` | `{ item }` |
| `trip.board.move` | Planner | `{ itemId, dayIndex, startTime, endTime, expectedVersion }` | `{ item }` |
| `trip.board.remove` | Planner | `{ itemId, expectedVersion }` | `{ itemId }` |
| `trip.board.lock` | Leader \* † | `{ itemId }` | `{ item }` |
| `trip.board.unlock` | Leader \* † | `{ itemId }` (overrides a lock) | `{ item }` |
| `trip.chat.send` | Viewer, not muted | `{ body, clientMsgId? }` | `{ message, duplicate }` |
| `trip.chat.typing` | Viewer, not muted | `{ isTyping }` | `{}` |
| `trip.chat.react` | Viewer | `{ messageId, emoji }` (toggles on/off) | `{ reactions }` |
| `trip.chat.history` | Viewer | `{ before?: ISO time, limit?: 1-100 }` | `{ messages }` (oldest first) |
| `trip.vote.open` | Leader | `{ itemIds: [2-6 ids], durationSeconds?: 10-3600 }` (items must compete for the same slot) | `{ vote }` |
| `trip.vote.cast` | Viewer | `{ voteId, itemId }` (one ballot each; casting again changes it) | `{ vote }` |
| `trip.vote.cancel` | Leader \* | `{ voteId }` | `{}` |
| `trip.ai.ask` | Viewer | same body as `POST /trips/{id}/ai/ask` | `{ result }` (same as the REST response) |
| `trip.board.setSharing` | Planner | `{ itemId, attendeeIds?: [ids] ([] = everyone), split: { type: "even" } or { type: "weighted", weights: { userId: 0-100 } }, expectedVersion }` | `{ item }` |
| `trip.split.propose` | Planner | `{ itemId, attendeeIds?, split, durationSeconds?: 10-3600 }` (opens a budget-split vote) | `{ vote }` |
| `trip.split.cast` | Viewer | `{ voteId, choice: "yes" or "no" }` | `{ vote }` |
| `trip.mod.mute` | Leader \* | `{ userId, muted }` | `{}` |
| `trip.mod.remove` | Leader \* | `{ userId }` | `{}` |
| `trip.mod.lockRoom` | Leader \* | `{ locked }` | `{}` |
| `trip.mod.transferLeader` | Leader \* | `{ userId }` | `{}` |
| `trip.sync.ping` | any | `{ clientSentAt }` | no ack; the server replies with `trip.sync.pong` |
| `trip.sync.report` | any | `{ rttMs }` (the client's measured round trip) | `{ quality }` |
| `auth.renew` | any | `{ token }` (a fresh access token for the same account) | `{ expiresAt }` |

\* **Sensitive.** Before running, the server checks that the access token has
not expired (`TOKEN_EXPIRED`; send `auth.renew`), and re-reads the account role
and the trip from the database.
† **Frozen while the leader is disconnected.** Refused with
`LEADER_DISCONNECTED`, even for Admins.

Moderation rules:
- You cannot target yourself.
- The leader cannot be muted or removed; transfer the role first.
- A removed traveller is disconnected at once, cannot reconnect, and cannot
  rejoin with the invite code.
- A locked room refuses new joins over REST (`403 ROOM_LOCKED`).

Chat bodies are cleaned on the server (HTML tags and invisible control
characters are removed). After cleaning they must be 1–1000 characters, and
they are always treated as plain text. `emoji` must be one of 👍 ❤️ 😂 😮 🎉 👎.
Re-sending with the same `clientMsgId` returns the original message
(`duplicate: true`) instead of posting it twice.

### Server → client

| Event | Sent to | Payload |
|---|---|---|
| `trip.sync.state` | the new connection | full snapshot: `{ trip, me: { userId, role, muted }, items[], budget, participants[], onlineCount, leader, conflicts[], votes[], chat[] (last 50), serverTime }` |
| `trip.board.update` | room | `{ action, itemId, dayIndex, startTime, endTime, lifecycleStage, positionVersion, item, byUserId }`; `action` is `pinned`, `moved`, `locked`, `unlocked`, `sharing_changed`, `voting`, `vote_won`, `vote_cancelled` or `removed` (`removed` carries only `itemId`, `positionVersion`, `byUserId` and, for a lost vote, `reason: "lost_vote"`) |
| `trip.board.conflict` | room | `{ conflictId, conflictType: overlap\|budgetBreach\|hours, itemIds, details: { message, ... }, status: "open", detectedAt }` |
| `trip.board.conflictResolved` | room | `{ conflictId, conflictType, itemIds, resolvedAt }` |
| `trip.vote.open` | room | `{ voteId, itemId, itemIds, candidates: [{ itemId, venueId, name }], candidateVenueIds, openedByUserId (null = the system), closesAt, status, ballotCount, tally }` |
| `trip.vote.cast` | room | `{ voteId, itemId, userId, choiceVenueId, changed, ballotCount, tally }` |
| `trip.vote.resolved` | room | `{ voteId, itemId (the winner), winningVenueId, tally, resolution: votes\|tie_earliest_pin\|no_votes_earliest_pin, removedItemIds }` |
| `trip.vote.cancelled` | room | `{ voteId }` |
| `trip.split.open` | room | `{ voteId, kind: "split", itemId, name, proposal: { attendeeIds, split }, openedByUserId, closesAt, status, ballotCount, tally: { yes, no } }` |
| `trip.split.cast` | room | `{ voteId, userId, choice, changed, ballotCount, tally }` |
| `trip.split.resolved` | room | `{ voteId, itemId, applied, tally, resolution: majority_yes\|majority_no\|tie_keeps_current\|item_changed }` |
| `trip.ai.suggestion` | room | `{ questionId, userId, displayName, question, answer, suggestedVenueId, sourceEvents, mode }` |
| `trip.board.rejected` | the losing client | `{ itemId, reason: "VERSION_CONFLICT", message, current: item }` |
| `trip.budget.update` | room | `{ currency, totalBudget, participantCount, itemCount, groupCommitted, remaining, overBudget, perPersonCommitted (the largest per-person total), perPerson: [{ userId, committed, ceiling, remaining, overCeiling }] }` |
| `trip.presence.update` | room | `{ participantId, displayName, action: "joined" or "left", participantCount (online), memberCount }` |
| `trip.presence.quality` | room | `{ participantId, rttMs, quality }`, sent when the quality bucket changes (good under 150 ms, fair under 400 ms, otherwise poor) |
| `trip.leader.status` | room | `{ leaderUserId, connected, awaySince, frozenActions }` |
| `trip.chat.message` | room | `{ messageId, userId, displayName, type, body, reactions, clientMsgId, meta, createdAt, tsSeconds }`; `type` is `chat`, `system`, `ai_answer` or `conflict` |
| `trip.chat.typing` | room except the sender | `{ userId, displayName, isTyping }` |
| `trip.chat.reaction` | room | `{ messageId, reactions: { "👍": [userId, ...] } }` |
| `trip.participant.updated` | room | `{ userId, muted?, role?, removed?, byUserId }` |
| `trip.participant.removed` | the removed person | `{ byUserId }`, after which the server disconnects them |
| `trip.participants.update` | room | `{ participants[], budget }`, after a REST change (join, role, settings) |
| `trip.room.locked` | room | `{ locked, byUserId }` |
| `trip.sync.pong` | the pinging client | `{ clientSentAt, serverReceivedAt }` |

**Participant entry:** `{ userId, displayName, role, muted, online, connections, rttMs, quality }`.

### Concurrent edits: what a client should do

1. Keep each item's `positionVersion`, and send it as `expectedVersion` when
   moving or removing the item.
2. If two moves race, the server applies whichever arrives first and bumps the
   version. The other gets `VERSION_CONFLICT` in its ack, plus a
   `trip.board.rejected` event holding the current item. Snap the card back to
   `current` and let the user try again.
3. Treat the `trip.board.update` broadcast as the truth. Either wait for it before
   moving the card, or move it straight away and undo the move if it is rejected.

### Conflicts

The server re-checks the board after every pin, move, remove, vote result,
change of people in the trip, and change to a traveller's preferences. It
announces each new problem once (`trip.board.conflict`), saves it in the chat
as a `conflict` message, and announces when it goes away
(`trip.board.conflictResolved`).

| `conflictType` | `details.reason` / `scope` | When |
|---|---|---|
| `overlap` | `time` | two items on the same day overlap |
| `overlap` | `travel` | the gap between consecutive items is shorter than the trip between them (walking up to 2.5 km, otherwise ~20 km/h plus 10 min waiting) |
| `budgetBreach` | `traveller` | the board's per-person total is above a traveller's `budgetCeiling`; `itemIds` holds the item that pushed them over |
| `budgetBreach` | `group` | the group total is above the trip's `totalBudget` |
| `hours` | | an item is scheduled while its venue is closed |

### Contested-slot votes

- **The system** opens a vote by itself when two drafting items have the same
  day and start time. **The Leader** can open one on any 2–6 drafting items
  that overlap the same stretch of time.
- Every participant, Viewers included, gets one ballot and can change it
  until the vote closes.
- The vote closes when its timer ends (`VOTE_SECONDS`, default 120 s) or as soon
  as every participant has voted. The option with the most votes wins. A tie,
  or no votes at all, goes to the option pinned first. The winner is locked in
  its slot and the other options are removed, in one broadcast that every
  client applies identically.
- Open votes are saved. If everyone leaves the room, or the server restarts,
  the vote is restored the next time the room opens; a vote whose time ran out
  in the meantime closes straight away.

### Presence, reconnects and the leader

- A traveller with several tabs open counts once.
- When a traveller's last connection drops, the room waits `PRESENCE_GRACE_MS`
  (default 5 s) before announcing `left`. Reconnecting inside that window is
  invisible to others (no `left`, no second `joined`), and `trip.sync.state`
  brings back the board, budget and chat.
- If the leader stays away longer than the grace window, `trip.leader.status`
  reports `connected: false` and lock/unlock are frozen until the leader (or a
  new leader, after a transfer) connects. Pinning, moving and chat carry on.
