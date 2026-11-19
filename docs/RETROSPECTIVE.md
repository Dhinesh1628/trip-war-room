# Retrospective (spec 12.1, 13.1)

## What was built

The full Track A (full-stack) system on the MERN stack, built in seven phases,
each ending with a working, tested checkpoint and its own commit:

| Phase | What it delivered |
|---|---|
| 0 | Project setup, health checks, test harness |
| 1 | Auth with rotating refresh tokens, four-tier roles, the Lisbon dataset and validator, venue search, trips and invites |
| 2 | The real-time board: version-checked moves, presence and reconnects, chat, leader moderation, the leader-away rule |
| 3 | The AI Concierge (rules decide, the model only words the answer, everything fact-checked), the conflict detector, contested-slot votes; later a free local-model option |
| 4 | The exact budget engine with attendance, weighted splits and split votes; the event log and session analytics; hybrid recommendations; the dashboard |
| 5 | The React UI, designed and approved as a mockup first |
| 6 | Load tests, measured performance, two performance fixes, a security review, the final documents |

Every spec acceptance criterion in sections 6, 10 and 13 maps to an automated
test or a measured number (see [TEST-REPORT.md](TEST-REPORT.md)).

## What went well

- **Pure cores, tested hard.** The board state machine, the budget engine, the
  constraint matcher, votes and the conflict detector are pure functions. That
  made it possible to test them with independent reference implementations and
  thousands of random cases instead of a handful of examples.
- **Keeping the LLM out of decisions.** Making the rules pick the venues and the
  model only write the sentence turned "100% constraint compliance" from a hope
  into a property of the code. It also meant the Concierge kept working when
  the API account had no credits.
- **Broadcast first, save in the background.** This kept sync drift in the
  low milliseconds even against a slow remote database.
- **Checking in a real browser found real bugs** that unit tests missed: a
  conflict message that didn't update as it grew, and restored votes failing
  after a server restart.

## What didn't go well, or was harder than expected

- **Network latency to Atlas.** About 60 ms per database round trip from a
  laptop to a free-tier cluster made several REST endpoints miss the 200 ms
  target, even though the same code answers in 10 ms or less locally. Some round
  trips were removed, but a few were kept on purpose (re-reading the user's role
  on every request, for immediate revocation).
- **The AI latency target couldn't be shown live.** The Claude account had no
  credits during testing, and the free local model needs 10–15 s per answer on
  a CPU. The 3 s target is protected by a timeout and template fallback, but a
  live Claude measurement is still missing.
- **Windows dev-server watching** restarted the server whenever files outside
  the source folder changed. That broke several measurement runs until
  measurements moved to a server without watching.
- **Test scripts need as much care as code.** The first load test reported
  failures that came from the test itself (pins landing in the same slot opened
  votes, as designed), not from the server.

## Deliberately cut or simplified (spec 13.2)

| Item | What was done instead | Why |
|---|---|---|
| Multiple server processes | One process; the scaling path is documented | Spec 4.1: single operator, local testing |
| Per-person attendance for dietary rules | All travellers' tags apply to every food suggestion | Simpler and strictly safer (never suggests something someone can't eat) |
| LLM-based question understanding | Rule-based parsing, plus explicit fields in the request | Predictable constraints, and one model call instead of two (latency) |
| Leader-away promotion | Freeze lock and unlock until the leader returns | The spec allows either; freezing is simpler and can't hand control to someone the leader didn't choose |
| Client unit tests | Browser verification, with rules enforced and tested server-side | Time; the server is the security boundary |
| Real venue and travel data | Five hand-authored Indian cities (122 venues, rupee prices, Wikimedia photos) with transit and mocked weather; Lisbon kept as a test fixture | Spec 4.2 and 14.1 |
| Deployment | Local only | Spec 4.2: public deployment is out of scope |

## What I'd do next with more time

1. **Measure Claude for real** and tune the prompt for latency (or try a smaller
   model), to report a live P95 against the 3 s target.
2. **Deploy next to the database** (API server and Atlas in the same region)
   and re-run the REST benchmark, which should put every endpoint well under
   200 ms.
3. **Playwright end-to-end tests** for the UI: two browsers, a pin, a vote, a
   conflict.
4. **Touch drag and drop** on phones (today you change the day in the card
   dialog).
5. **Per-item attendance for dietary rules and the Concierge**, now that the
   budget engine already knows who attends what.
6. **Incremental conflict and budget updates**, so acknowledgements stay fast
   on very large boards (the 50-person, 600-card stress test).
7. **Real listings and prices**: the Indian datasets are hand-authored; a
   real catalogue would come from a places API, with prices kept up to date.
8. **Horizontal scaling**: the Socket.io Redis adapter, a shared event bus, and
   rate-limit counters in Redis.


