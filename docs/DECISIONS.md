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

**Money.** Prices are stored as numbers with at most 2 decimals, in the
destination's currency. The budget engine does its arithmetic in integer
hundredths (paise or cents) so totals are exact. Lodging `pricePerPerson` means
per person per night. (Originally USD only, following the spec's "$" examples;
see "India edition" below.)

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

## Phase 3

**The rules decide; Claude only writes the sentence.** The Concierge is a
pipeline: read the question → apply the hard rules → rank → phrase. Only the
last step uses the LLM. So every suggestion satisfies every active constraint
whatever the model writes (spec 6.2, 14.2: "enforced in code"). Claude gets only
the top 5 venues that passed, and structured output (`output_config.format`
with a JSON schema) restricts `suggestedVenueId` and `citedVenueIds` to those
ids, so it cannot name a venue that failed or doesn't exist.

**Every reply is fact-checked before it is used.** Even with the ids locked
down, free text could still contain an invented price or time. The server checks
the reply: every `$` amount, every time (24-hour or "8 pm"), every "N-minute walk"
and every dataset venue name it mentions must appear in the facts Claude was
given. If anything fails, the deterministic template answer is used instead and
`fallbackReason: "ungrounded"` is recorded. The same fallback covers no API
key, timeouts, refusals, cut-off replies and API errors, so the Concierge
always answers, and always truthfully.

**Questions are read with rules, not with the LLM.** Turning "under $25",
"vegan", "near our 5 PM tour" or "within 500 m" into constraints is done with
small, tested patterns (`src/concierge/interpret.js`). An LLM extraction step
would add a second model call (blowing the 3-second budget) and make the
constraints themselves unpredictable. The trade-off is that unusual phrasing
may be missed. When the question names nothing, the request body can pass
`category`, `maxPricePerPerson`, `dietaryTags`, `time`, `anchorItemId` and so
on explicitly.

**Interpreting the spec's rules:**
- *Budget ceiling:* the question's price wins; otherwise the asker's
  remaining `budgetCeiling`; otherwise the group's remaining budget per person.
- *`budgetCeiling` is a whole-trip ceiling per traveller.* Spec 5.3 talks about
  a pinned item pushing "any traveller's running total over their declared
  ceiling", so the ceiling has to be a total, not a per-item limit. (Phase 1
  described it as per item; that is corrected here.)
- *Dietary:* the tags of everyone in the trip (until Phase 4 adds per-item
  attendance, everyone attends everything), plus any in the question. Only
  food and drink venues are checked. A tag must match exactly; for example a
  vegan venue does not automatically count as vegetarian unless it is tagged so.
- *Hours with a buffer:* "near/after our tour" means the visit starts 30 min
  after the anchor ends ("before" means it ends 30 min before the anchor
  starts) and lasts a typical time for the category (dinner 90 min, lunch 60,
  ...). The venue must be open for the whole visit. Venues open past midnight
  are handled.
- *Proximity:* only when the question refers to something on the board.
  Without an anchor every venue scores the same 40% proximity share, and
  ranking falls to rating and headroom.
- *Ranking:* rating/popularity is 75% the rating and 25% the log of the review
  count (so a 5,000-review 4.5 doesn't lose to a 3-review 4.6).

**Model choice: `claude-opus-5-5` at `low` effort.** It's the current default
model. The task is short phrasing from supplied facts, so low effort is
enough, and thinking can't be switched off on this model. `CONCIERGE_MODEL`
and `CONCIERGE_EFFORT` can change it. The call has a 2.5 s timeout and no
retries, so the 3 s P95 target (spec 10.2) holds even when the API is slow:
a slow reply is replaced by the template answer, and the fallback is logged.
The request also opts into server-side refusal fallbacks
(`fallbacks: "default"`), so a safety-classifier decline is retried on a
recommended fallback model within the same call.

**A free local model is an option (`CONCIERGE_PROVIDER=ollama`).** Spec 8.1
and 14.1 allow "a local open-source model". Through Ollama's chat API, a local
model (default `llama3.2:3b`) gets the same facts, the same system prompt and
the same JSON schema (Ollama's `format` field), so its venue ids are limited
to the candidates in the same way. The same fact check and template fallback
apply. The model is loaded into memory when the server starts and kept loaded
for 30 minutes, so questions don't pay the loading time. The trade-off is speed
on a laptop without a dedicated GPU; the measured numbers are reported with
the Phase 6 performance results.

**Cost control.** Claude is not called when nothing passes the rules, each
traveller is limited to 20 questions a minute, and the prompt only carries
the top 5 candidates (a few kilobytes of JSON; real token counts are logged
with every answer as `inputTokens` / `outputTokens`).

**Conflict detector.** A pure function over the board and the travellers,
re-run after every change. Each conflict has a stable id, so it is announced
once when it appears and once when it is resolved. Besides the spec's two types
(time overlap, budget breach), it flags two problems that the spec's "overlapping
in time or location" points at: not enough time to travel between consecutive
items, and an item scheduled while its venue is closed. Flags are broadcast
synchronously after the change (19 ms at most over 20 tests, against the
1-second target) and also saved as `conflict` chat messages for the analytics in Phase 4.

**Voting.** Spec 6.2 says the system opens a vote "when two items are pinned
to the same slot": this is read as same day and same start time. The leader can
open a vote on any items that overlap. Viewers can vote (spec 5.1: some people
"only vote"). The vote closes when its timer ends or everyone has voted. A tie,
or no votes, goes to the option pinned first, so the outcome is always
deterministic. The winner is locked (finalised by the group) and the other
options are removed. Open votes are saved and restored when a room reloads.
Votes are not frozen while the leader is away, because only lock/unlock (the
leader's own finalise actions) are.

## Phase 4

**Budget engine: whole cents and the largest-remainder method.** Every amount
is an integer number of cents. An item costs `pricePerPerson × attendees` and
is split evenly or by whole-number weights. Rounding leftovers go one cent at
a time to whoever has the largest remainder (ties: lower user id). This makes
the result deterministic and exact: each item's shares add up to its cost,
people's totals add up to the group total, and nobody is ever more than one
cent from their exact share. A randomised test checks this over 2,000 splits
and 300 random trips, alongside hand-worked examples.

**Who attends.** By default everyone attends every item. Planners can name the
attendees (for example, only two people going sailing) and set weights (for
example, 2:1:1 for a bigger room). Changing this uses the same version check as
moving a card. The conflict detector and the Concierge's budget ceiling now use
each person's real share, not an even split.

**Budget-split vote.** Spec section 2 mentions running "a budget-split vote to
resolution", but no section defines one. It is read as: anyone can propose a new
sharing setup for one item; everyone votes yes or no; when the timer ends or
everyone has voted, more yes than no applies it, and a tie keeps things as they
are. If the item changed during the vote, the proposal is dropped, because people
voted on something that no longer exists.

**Event log.** Every board change, vote, conflict, Concierge question, chat
message (counted, never the text) and presence change is written to
`tripevents`, saved in the background with the board. Rows have a strictly
increasing `seq` and a unique `(tripId, seq)` index, so a retried save can't
duplicate them.

**Analytics come only from the log.** `GET /trips/{id}/analytics` counts log
rows, takes peak attendance from presence rows, rebuilds the final board by
replaying item events, and computes the final budget from that rebuilt board.
It also compares the replay with the stored board (`reconciliation`). That is
how the spec's "reconcile exactly with the underlying event log" is checked,
for a hand-worked session in the tests and for any trip on demand.
"Planning duration" is the time from the first logged event to the last.

**Interactions.** Each pin is a like; a ballot in a slot vote is a like for the
option chosen; removing *someone else's* card is a dislike (removing your own is
just a change of plan); an explicit like or dislike counts double. Each row
records who the person was planning with, for group affinity.

**Recommendations.** A hybrid of:
- content-based: cosine similarity between a venue's features (category,
  price band, dietary tags, area, indoor/outdoor) and the person's taste
  profile (liked features minus disliked);
- user-based collaborative filtering: what people with similar likes liked,
  with people they've travelled with counting 1.5×.

Scores are mixed 50/50. People with fewer than 3 signals get content-only, and
people with none get a popularity ranking. α = 0.5 was fixed *before*
measuring and not tuned on the test set; a sweep showed 0.2–0.5 perform about
the same. Group recommendations average the members' scores, skip venues already
on the board, and keep only food venues that fit everyone's dietary tags.

**"Updates without a retrain cycle".** The model is rebuilt from the
interactions collection whenever a new interaction has arrived since the last
build, and cached until then. At this scale (about 1,700 rows) a rebuild takes
milliseconds. A large system would update the matrix incrementally or retrain
on a schedule; the spec explicitly allows a batch job.

**Generated interaction data and the evaluation.** `src/recs/generate.js`
creates 120 synthetic travellers with five personas (plant-based foodie,
budget backpacker, culture seeker, night owl, luxury), puts them on trips
mostly with like-minded people, and has them like the venues their persona
would (85%), plus noise (4%), plus two dislikes each. Each traveller's likes
are split into "past trips" (training, 55%) and "next trip" (held out). Precision@5
asks whether the top 5 recommendations, from venues they haven't interacted
with, are ones they go on to like. Only travellers with at least 5 held-out
likes are scored (about 82 of 120), since otherwise a perfect model could not
reach 1.0. Results over 5 seeds (`npm run eval:recs`): popularity 0.122,
content-only 0.555, collaborative-only 0.726, **hybrid 0.735** (target ≥ 0.6).
Caveat: synthetic personas are cleaner than real people, so real-world
precision would be lower. The number shows the pipeline works, not how it would
perform on real users.

**Synthetic travellers in the live database.** `npm run generate:interactions`
loads the same generated history into MongoDB with `source: "generated"`, under
stable fake user ids that are not real accounts, so live recommendations have
something to learn from. Re-running it replaces only those rows.

## Phase 5

**The design was agreed first.** A mockup of the trip room was approved
before any UI code was written: neutral greys, one accent colour (blue, for
votes and the main action), warning and danger colours only for problems,
outline icons, no gradients or emoji, and a serif font for the Concierge's
answers so AI text stands out.

**Chat reactions are icons.** The backend keeps the six fixed emoji
reactions the spec asks for, but the UI shows them as outline icons with a
count (thumbs up, heart, smile, surprise, confetti, thumbs down), to keep the
no-emoji look.

**The server is the only source of truth.** The board never changes a card
locally; it waits for the server's `trip.board.update` broadcast, which
arrives within milliseconds. A move that loses a race is simply never shown,
and a short notice says someone else moved the card first. This keeps every
screen identical and makes the conflict handling from Phase 2 visible
without extra client logic.

**Tokens stay in memory.** The access token is never written to
localStorage, so injected script can't read it from storage. The httpOnly
refresh cookie signs a returning visitor back in. A request that hits an
expired token refreshes once and retries, and an open socket is handed the
new token with `auth.renew`.

**Drag and drop uses the browser's own API, with the card dialog as the
touch alternative.** HTML5 drag and drop moves a card to another day; the
card dialog changes day and time on any device. No drag-and-drop library was
added.

**No client unit tests.** The client is checked in a real browser, in light
mode, dark mode and at phone width. The rules it relies on (budget maths,
versions, votes, permissions) are tested on the server, which enforces them
whatever the client does. A browser end-to-end suite such as Playwright would
be the next step.

**Bugs the UI testing found (fixed and covered by tests):**
- A budget breach that grew kept showing its first amount, because a
  conflict was only announced when it first appeared. It is now re-sent
  whenever its details change, without a second chat notice or log row.
- After a server restart, a restored vote compared database ObjectIds with
  strings and failed when someone voted. Ids are now normalised when a vote is
  restored.

**Development restarts.** `node --watch` reacted to file changes in the
whole server folder, so the dev server restarted at odd moments. The dev
script now uses `--watch-path=src`. On Windows, Node's watcher may still fire
once right after startup; this affects development only, not `npm start`.

## Phase 6

**Measure twice: local and Atlas.** Every measurement was run against a local
in-memory database and against the real Atlas cluster. That separates the
code (REST P95 ≤ 10 ms locally) from the network (about 60 ms per Atlas round
trip from this laptop). See [PERFORMANCE.md](PERFORMANCE.md).

**Two performance fixes; one deliberately not made.**
- A venue catalog cache (`src/venues/catalog.js`), cleared whenever a dataset
  is loaded. Above 2,000 venues, distance searches still go to the database
  query on the spec's compound index.
- Token refresh in two round trips instead of four, using one atomic claim.
- Not done: caching the user lookup in `requireAuth`. It would save a round
  trip per request, but then removing someone's admin rights would no longer
  take effect immediately.

**Security fix: invite codes can't be brute-forced.** Invite previews and
joins are limited to 30 per 15 minutes per account (tested). The full review
is in [SECURITY.md](SECURITY.md).

**Load-test mode.** `dev:memory -- --bench` lifts the sign-up, Concierge and
invite rate limits so a load test can create many accounts. It prints a
warning, and it can't be switched on through the normal server.

**Live role changes on the client.** A role change made over REST (for
example "Make viewer") now updates the traveller's own role on screen
straight away, not only the people list.

## India edition (after Phase 6)

**India only.** The app ships five Indian cities. The Lisbon dataset moved to
`server/test/fixtures/`: most hand-checked tests (worked budget examples, the
spec's "dinner near our 5 PM tour under $25") are written against it, and
keeping it fixed keeps those checks meaningful. `npm run seed -- --prune`
removes destinations that are no longer in `server/data/destinations`.

**Rupees, per destination.** Each dataset declares its currency (`INR` or
`USD`); trips, budgets, analytics, conflict messages and Concierge answers use
it. Amounts are shown with Indian digit grouping (₹1,20,000). The question
parser reads "under ₹800", "below Rs 1,200", "under 800 rupees" and "₹500 per
person"; the grounding check accepts any of those forms and rejects a price
that isn't in the data, whatever symbol is used. Landmark prices are the
Indian-visitor ticket rates, since the app is aimed at Indian travellers.

**Price-based features scale with the currency.** The recommender's price
bands and the synthetic travellers' tastes were written in dollars. Rather than
rewrite them, they are multiplied by a per-currency factor (60 for rupees), so
a ₹250 café is "budget" and a ₹9,000 hotel night is "luxury".

**Photos from Wikimedia Commons.** Each venue stores one photo (URL, author,
licence, file page), chosen from the lead image of a related Wikipedia article
and kept only if the file is on Commons under a free licence. Every photo shows
its credit and links to its Commons page, as CC BY-SA requires. Images are
loaded from Wikimedia's servers, so the content-security policy allows
`upload.wikimedia.org` and `thumb.wikimedia.org` for images only. The upload
validator accepts only those hosts.

**Saved places.** The heart button stores venue ids on the user
(`savedVenueIds`, newest first, at most 200). Saving also records a "like"
for the recommender. No separate collection: it is a short list read with the
user.

**Design.** Black and white and photo-led, based on the reference design the
user chose (a mobile booking app) and an Airbnb-like search bar and category
row. Layout ideas only: the app keeps its own name and mark, and uses no
Airbnb branding, logo or colours.

## Fixes after the review (after the India edition)

**Photos are self-hosted.** The 127 photos (122 places, 5 cities) were downloaded
once from Wikimedia Commons at 500 px (places) and 1,280 px (cities), about 9 MB,
and are served by the app with long cache times. Each keeps its author, licence
and Commons link. Venues whose photo shows a related dish, street or landmark
rather than the place itself are marked `representative` and labelled. The six
places that only had a city photo got better matches by searching Commons.

**Real walking times, computed once.** The free OpenStreetMap foot-routing
service (FOSSGIS) gave a footpath-distance table for each city at data-build
time; nothing calls it while the app runs. The Concierge's "N-minute walk",
travel-time clashes and "Nearby on foot" use these (80 m a minute). The
distance rule itself still uses straight-line kilometres, as the spec defines
it. Pairs without a route fall back to the old estimate.

**Map: Leaflet with OpenStreetMap tiles**, loaded only when someone opens the
map (it is the largest library). Tiles are credited as the tile policy asks.

**Sign-in options switch on with their keys.** Password reset, email
confirmation and invites (Resend), Google (Google Identity Services, verified
on the server with Google's public keys instead of an extra library, which
had a vulnerable dependency), and phone codes (Twilio). The server reports
which are available (`GET /auth/providers`) and the client shows only those.
Locally, without keys, a test inbox stands in.

**Accounts without an email.** Phone accounts have no email, so the unique
indexes on email, phone and Google id became partial (unique when present).
The server updates the index on start-up.

**Signed-in home page.** `/` is now a dashboard (summary numbers, the next trip,
invitations, recent activity); Explore moved to `/explore`.

**Languages: English text is the key.** Each translation file maps the English
string to its translation, and missing ones show in English, so a new string
is never blank. A test extracts every string passed to `t()` and fails if any
language lacks it or changes a placeholder. Language files load on demand.
The Concierge still reads English questions.

**Touch dragging uses a grip handle.** Pressing the grip and dragging moves the
card (the board scrolls sideways near the edge); the rest of the card still
scrolls the page normally, which a long-press on the whole card would break.

**Offline: read-only, on this device.** The service worker caches the app and
photos; the trip room keeps the last board in local storage and shows it
read-only without a connection. Sign-out deletes those copies.
