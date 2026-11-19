# Demo walkthrough (for the recording, spec 12.2 and 13.1)

A script for a 6–8 minute screen recording that shows every piece of evidence
the spec asks for: two or more sessions live in one room, a Concierge
suggestion with cited sources, a conflict detected and resolved, a full
contested-slot vote, and server-side RBAC.

## Before you record

1. Start the app (see the README): `npm run dev --prefix server` and
   `npm run dev --prefix client`. For the Concierge, either set
   `CONCIERGE_PROVIDER=ollama` (start the Ollama app first) or add an Anthropic
   key; without either it answers from the template, which is fine too.
2. Open **two browser windows side by side**: a normal window and a private
   window (each needs its own account and cookies). Optionally a third private
   window in another browser.
3. Make the window width about 1,280 px each, or use one large screen.

## Scene 1: set up the room (1 min)

1. Window A: register **Maya**. On the dashboard, under "Your needs", leave
   the defaults. Start a trip from the search bar: Where Jaipur, When Dec 10 to 14, Who 4, Budget ₹40,000.
2. In the trip room, click the invite code to copy the link.
3. Window B: open the link, register **Sam**, and press **Join trip**.
4. Point out: both avatars are green (online) in both windows.

*Shows: auth, trip creation, invite link, join flow, presence.*

## Scene 2: live sync (1 min)

1. Window A: **Pin a venue** on day 1 → search "walking tour" →
   *Alfama Old Quarter Walking Tour*, 17:00–19:00. It appears in window B at once.
2. Window B: pin *Castelo Hilltop Fortress* on day 1, 10:00–11:30.
3. Window A: drag the castle card to day 3. It moves in window B immediately.
4. The budget panel updates in both windows ($42 per person).

*Shows: board updating live as both pin and move (spec 12.2, item 1).*

## Scene 3: a conflict, detected and resolved (1 min)

1. Window B: pin *Tram 28 Heritage Ride* on day 3, 11:00–12:00. It overlaps
   the castle. A yellow warning appears in **both** windows, the cards get a
   warning icon, and a notice appears in chat.
2. Window B: open the tram card, change the time to 12:30–13:30 and press
   **Save time**. The warning disappears in both windows.
3. Optional: in window B's dashboard set "Most you want to spend" to 30 and
   pin something expensive; a budget breach for Sam appears.

*Shows: conflict detected and resolved (spec 12.2, item 3).*

## Scene 4: AI Concierge (1 min)

1. Window B, Concierge panel: ask
   *"Suggest a dinner spot near our 5 PM tour under $25/person"*.
2. Point out: the answer, the cited venues under it (name and price), and
   "rules checked · N sources". The answer also appears in Maya's chat.
3. Press **Pin it**: the suggested venue opens in the pin dialog with the
   suggested time filled in.

*Shows: constraint filtering, a grounded answer, cited venue metadata
(spec 12.2, item 2).*

## Scene 5: a full contested-slot vote (1–2 min)

1. Window A: pin *Horta Verde* on day 2, 19:00–20:30.
2. Window B: pin *Sabor de Marrakech* on day 2, 19:00–20:30 (the same slot).
3. A vote opens automatically in both windows, with a countdown. Both cards
   show "vote" and can't be moved.
4. Maya votes Horta Verde, Sam votes Horta Verde. As soon as everyone has
   voted, it closes: Horta Verde is locked in place, Sabor de Marrakech
   leaves the board, and chat says who won and why.

*Shows: a vote opened, cast and resolved, applied identically for everyone
(spec 12.2, item 4).*

## Scene 6: roles enforced by the server (1 min)

1. Window A (leader), People panel: on Sam, press **Make viewer**.
2. Window B: the "Pin a venue" buttons disappear, because Sam is now a Viewer.
3. To show it's the server refusing, not just the UI hiding buttons, run in a
   terminal:

   ```bash
   npm run smoke --prefix server
   ```

   It prints PASS lines for "viewer blocked from leader-only settings
   (status 403)" and "leader blocked from admin-only datasets (status 403)".
   The full matrix is in `rbac.test.js` (`npm test`).

*Shows: RBAC enforced server-side (spec 12.2, item 7).*

## Scene 7: analytics and tests (1 min)

1. Window A: open **Analytics**. Point out the banner saying the event log
   replays exactly to the board, the session numbers, and the cost-per-person
   table.
2. Terminal: `npm test` (or show its summary): 377 tests passing.
3. Optional: `npm run demo:room --prefix server` shows three scripted
   travellers colliding on the same card and the measured sync drift.

*Shows: analytics reconciling with the log, the test run (spec 12.2, item 5).*

## Numbers to mention

From [PERFORMANCE.md](PERFORMANCE.md):
- sync drift P95 1–6 ms (target < 100 ms), including 50 travellers in one room;
- 100% constraint compliance over 379 simulated requests;
- conflict flags within 19 ms;
- Precision@5 of 0.735 (target 0.6);
- REST P95 ≤ 10 ms with a local database, slower over a remote free-tier
  Atlas cluster (explained in the report).
