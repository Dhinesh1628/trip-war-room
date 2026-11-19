# Security review (spec 10.1, 11.1 week 4)

A review of the finished system, done in Phase 6. Each item says what was
checked and how; "tested" means an automated test covers it.

## Secrets (spec 10.1, 14.2: zero tolerance)

| Check | Result |
|---|---|
| Real secrets in any commit | **None.** All history was searched (`git log --all -p`) for the Atlas connection string, the database password, `sk-ant-` API keys, the JWT secret, private keys and the local test password. The only `sk-ant-` match is the test placeholder `sk-ant-x`. |
| Secret files tracked by git | None. `.env`, `.env.*` (except `.env.example`) and `*.local.json` are git-ignored. |
| Secrets in source | None hard-coded. `MONGO_URI`, `JWT_SECRET` and `ANTHROPIC_API_KEY` come only from the environment; the server refuses to start without the first two, or with a JWT secret under 32 characters (tested). |
| Secrets in logs | The logger is never passed tokens, passwords or chat text. Concierge logs hold ids, modes and timings, not the question. API error details from Anthropic don't contain the key. |

## Authentication

| Check | Result |
|---|---|
| Passwords | bcrypt (cost 10), never returned by the API (tested). Passwords over 72 bytes are refused, because bcrypt would silently ignore the rest. |
| Login | A wrong password and an unknown email give the same answer, checked against a dummy hash so the timing matches (tested). Rate-limited to 20 per 15 minutes per IP (tested). |
| Access tokens | HS256 JWT with the algorithm pinned; `none` and other keys are rejected (tested). They last 15 minutes, and the config refuses more than 1 hour (tested). |
| Refresh tokens | Random 48-byte tokens in an httpOnly, SameSite=Strict cookie scoped to `/api/v1/auth`, and `Secure` in production. Only SHA-256 hashes are stored. They rotate on every use, and re-using an old token revokes the whole session (tested). Two parallel refreshes can't both succeed (tested). |
| Revocation | Every request re-reads the user, so removing admin rights or deleting an account takes effect at once (tested). |
| Client storage | The access token is kept in memory only, never localStorage. A read-only copy of your last boards is kept on the device for offline viewing; signing out deletes it. |
| Keep me signed in | Unticked: the refresh cookie has no expiry (it ends with the browser) and the token lives 24 hours; the choice survives refreshes (tested). |
| Password reset | Single-use links (32 random bytes, stored as SHA-256 hashes) that expire after 30 minutes. Asking for one answers the same way whether or not the email has an account. Resetting signs out every other session (tested). |
| Email confirmation | The same kind of link, valid for 48 hours and tied to the address it was sent to (tested). |
| Sign in with Google | The ID token is verified on the server: RS256 signature against Google's published keys, issuer, audience (our client id) and expiry; forged, foreign and unknown-key tokens are refused (tested). A Google account links to an existing account only when Google says the email is verified (tested). |
| Phone codes | 6 digits from a secure random source, stored hashed with a server secret, valid 5 minutes, 5 wrong tries then locked, 3 codes per number per 10 minutes, only the newest code works, compared in constant time (tested). |
| Signing out elsewhere | Changing the password and "Sign out other devices" revoke every other session but keep this one (tested). |

## Access control (spec 10.1: enforced server-side)

| Check | Result |
|---|---|
| Four roles on REST | `rbac.test.js` tries every protected action as an outsider, Viewer, Planner, Leader and Admin; anything not allowed gets `403` (30 cases), and no token gets `401`. |
| Four roles on WebSocket | The handshake checks the JWT and trip membership (tested: no token, forged token, outsider, unknown trip). Every event checks the role; Viewers can't pin, Planners can't lock or moderate (tested). |
| Re-validation on sensitive actions | Lock, unlock, vote cancel and moderation re-check token expiry and re-read the account and trip from the database (tested, including an expired token mid-session). |
| Mass assignment | Registration ignores `role`; `PATCH /users/me` refuses unknown fields such as `role` (tested). |
| Data exposure | Trip views show display names, not emails. Invite codes are only shown to Leaders and Admins (tested). |
| Removed travellers | Disconnected at once; they can't reconnect or rejoin with the invite code (tested). |

## Input validation and injection

| Check | Result |
|---|---|
| Request bodies and queries | Every REST body and query, and every WebSocket payload, goes through a strict zod schema. Unknown fields, wrong types and out-of-range values are refused with `400` and field-level details (tested across all suites). |
| NoSQL operator injection | Not possible through the API: values are type-checked before use, so an object like `{ "$gt": "" }` where a string is expected fails validation. Route parameters are always strings, and ObjectIds are checked before use. |
| Stored XSS | Chat is cleaned on the server (HTML tags and invisible control characters removed; tested with `<script>`, `<img onerror>` and similar). React renders all text as text; the app never uses `dangerouslySetInnerHTML`. |
| Dataset uploads | Admin-only; every field is validated (price, tag vocabulary, lat/lng ranges, time format, duplicates, unknown fields), and nothing is saved if anything fails (tested). |
| Size limits | JSON bodies are capped at 1 MB and WebSocket messages at 64 KB. |
| LLM output | Never trusted. Venue ids are limited to the candidates by the schema, and the text is fact-checked before use (tested with invented prices, venues and times). |

## Transport and headers

- `helmet` sets the standard security headers, including `X-Content-Type-Options`, frame protection and a Content Security Policy. The policy is same-origin, plus exactly what the app uses: map tiles from `tile.openstreetmap.org`, Wikimedia image hosts (for admin-uploaded datasets), and Google Identity Services for Sign in with Google.
- CORS only allows the configured client origin. Socket.io uses the same origin rule.
- CSRF: API calls use Bearer tokens (not cookies), so they can't be forged
  cross-site. The one cookie-based endpoint (`/auth/refresh`) is SameSite=Strict.
- Error responses never include stack traces.

## Abuse limits

| Limit | Value |
|---|---|
| Register and login | 20 per 15 minutes per IP |
| Concierge questions | 20 per minute per traveller (tested) |
| Joining and invite previews | 30 per 15 minutes per account (added in this review; see below) |
| Password reset, email links, Google and phone sign-in | Share the register/login limit: 20 per 15 minutes per IP |
| Phone codes | 3 per number per 10 minutes; 5 wrong tries per code |
| Email invites | 30 per trip per day, leader only |
| Reviews | One per traveller per place (writing again replaces it); text cleaned like chat |
| Trip size | 50 people per room, enforced atomically (tested with a 5-way race for the last seat) |

## Dependencies

`npm audit`, run on 2026-11-19:
- server production dependencies: **0 vulnerabilities**
- client: **0 vulnerabilities**
- server development dependencies: moderate advisories in `glob`/`minimatch`
  pulled in by Jest. These run only in tests and never ship; the suggested fix
  is a breaking Jest change, so they are accepted for now.

## Fixed during this review

- **Invite codes could be guessed without limit.** The preview
  (`GET /trips/invite/{code}`) and `POST /trips/join` endpoints had no rate
  limit, so a signed-in account could try codes as fast as it liked (31⁶ ≈ 887
  million combinations). Both are now limited to 30 attempts per 15 minutes per
  account (tested).

## Known limitations (accepted for this project's scope)

- Admin role changes made with the `make-admin` script take effect at once,
  because every request re-reads the role; there is no admin UI for role
  management.
- One process holds the rate-limit counters in memory, so they reset on
  restart and aren't shared between processes. A shared store such as Redis
  would be needed for several servers.
- `--bench` mode on the in-memory dev server lifts the rate limits for load
  testing. It is only reachable through `scripts/dev-memory.js` and must never
  be used on a deployment.
- Email and SMS go through third-party providers (Resend, Twilio) once
  configured; their delivery and logs are outside this app.
- The local test inbox shows sign-in codes and reset links in plain text. It
  is mounted only when NODE_ENV is not production.
