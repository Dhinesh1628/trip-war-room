# API reference

Base URL: `http://localhost:5080/api/v1`. All bodies are JSON.
WebSocket events are documented in Phase 2.

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
`budgetCeiling` is USD per person per item, or `null`. `role` cannot be set here (`400`).

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
