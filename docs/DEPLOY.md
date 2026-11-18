# Deploying to Render

One Render web service runs the REST API, the WebSocket gateway, **and**
serves the built React site, so the whole app lives at one URL (for example
`https://trip-war-room.onrender.com`). The database stays on MongoDB Atlas.

Everything Render needs is in the repo:

| File | What it does |
|---|---|
| `render.yaml` | Tells Render how to build, start and health-check the app, and which settings to ask for |
| `package.json` (root) | `npm run build` installs both halves and builds the site; `npm start` starts the server |

In production the server serves `client/dist` itself, answers page URLs such as
`/trips/…` and `/join/…` with the app, and uses Render's public address
(`RENDER_EXTERNAL_URL`) for invite links. Render's free plan supports WebSockets.

Time needed: about 15 minutes, mostly waiting for the first build.

## 1. Prepare MongoDB Atlas

**a) Let Render connect.** Render's free plan has no fixed IP address, so
Atlas must accept connections from anywhere; the database password is what
protects it.
Atlas → **Security → Network Access → Add IP Address → Allow Access from
Anywhere** (`0.0.0.0/0`) → **Confirm**.

**b) Use a fresh password.** The development password was shared in a chat,
so replace it: Atlas → **Security → Database Access** → your user → **Edit →
Edit Password → Autogenerate Secure Password** → copy it → **Update User**.
Then update `MONGO_URI` in your local `server/.env` too.

**c) The connection string** looks like this (your user, the new password, and
the database name `trip-war-room` after the `/`):

```
mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/trip-war-room?retryWrites=true&w=majority
```

If the password has symbols like `@ : / ? #`, URL-encode them (`@` → `%40`,
`#` → `%23`), or autogenerate one without symbols.

**d) Data.** If you use the same database you developed with, the Lisbon venues
and the generated recommendation history are already there. For a new database,
run these once from your computer with `MONGO_URI` pointing at it:

```bash
npm run seed --prefix server
```

```bash
npm run generate:interactions --prefix server
```

## 2. Create the service on Render

1. Sign in at **render.com** with your GitHub account.
2. **New → Blueprint**, connect the **trip-war-room** repository, branch `main`.
3. Render reads `render.yaml` and shows one service, **trip-war-room**. It asks
   for **MONGO_URI**: paste the connection string from step 1c.
   (`JWT_SECRET` is generated for you; `NODE_ENV`, `TRUST_PROXY` and the rest
   are set by the file.)
4. Click **Apply**. The first build takes about 3–5 minutes. It's done when the
   logs show `API + gateway listening` and the service shows **Live**.

**Optional, Claude for the Concierge:** service → **Environment → Add
Environment Variable** → `ANTHROPIC_API_KEY` = your key (with credits) →
**Save**. Without it, the Concierge gives the same rule-checked suggestions
with template wording. (Ollama can't run on Render's free plan.)

## 3. Check it works

1. `https://<your-app>.onrender.com/api/v1/health` shows
   `{"status":"ok","db":"connected"}`.
2. Open the site, create an account, start a trip, and pin a venue.
3. Copy the invite link from the trip room, open it in a private window,
   register a second account and join: both windows update live.

## 4. Updating

Every `git push` to `main` makes Render rebuild and redeploy. The old version
keeps serving until the new one passes `/api/v1/health`.

## Troubleshooting

| Symptom (in Render's logs) | Fix |
|---|---|
| `MongoServerSelectionError` or a timeout | Atlas Network Access is missing `0.0.0.0/0` (step 1a) |
| `bad auth : authentication failed` | Wrong user or password in `MONGO_URI`, or unencoded symbols in it |
| `Missing required environment variables` | Render → service → **Environment** → add the missing one |
| Build fails at `vite build` | Run `npm run build --prefix client` locally and fix the error it shows |
| The first visit takes 30–60 s | Normal on the free plan: the service sleeps after 15 minutes without visitors |
| Trip room shows "Reconnecting" for a while after waking | Same cause; it resyncs by itself once the service is up |

## Free-plan limits worth knowing

- The service sleeps after 15 minutes idle; the first request wakes it (30–60 s).
- One instance only. That matches this app's single-process design (see
  [ARCHITECTURE.md](ARCHITECTURE.md)); live rooms reload from the database after a restart.
- Response times depend on where Render and Atlas run. Pick the **same region**
  for both (for example Frankfurt and Atlas eu-central-1) for the fastest API.
