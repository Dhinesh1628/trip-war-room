// REST API latency benchmark (spec 10.2: non-AI endpoints P95 < 200 ms).
// Measures end-to-end time for each endpoint as a client sees it, against a
// RUNNING server. Requests run one at a time (no queueing effects).
//
// Usage: npm run bench:api -- [baseUrl] [requestsPerEndpoint=40]
const [base = 'http://localhost:5080', nArg = '40'] = process.argv.slice(2);
const N = Number(nArg);
const api = `${base.replace(/\/$/, '')}/api/v1`;
const stamp = Date.now().toString(36);

async function timed(method, path, { token, body, cookie } = {}) {
  const t = performance.now();
  const res = await fetch(api + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const ms = performance.now() - t;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  const set = res.headers.getSetCookie?.() ?? [];
  return { ms, json: text ? JSON.parse(text) : null, cookie: set.find((c) => c.startsWith('twr_refresh='))?.split(';')[0] };
}

const pct = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * q) - 1)];

const reg = await timed('POST', '/auth/register', { body: { email: `bench-${stamp}@example.test`, password: 'bench test password', displayName: 'Bench' } });
const token = reg.json.accessToken;
let cookie = reg.cookie;
const trip = (await timed('POST', '/trips', { token, body: { destination: 'lisbon', startDate: '2026-12-10', endDate: '2026-12-14', totalBudget: 1200 } })).json;

const endpoints = [
  ['GET /health', () => timed('GET', '/health')],
  ['GET /auth/me', () => timed('GET', '/auth/me', { token })],
  ['GET /destinations/lisbon/venues?near', () => timed('GET', '/destinations/lisbon/venues?near=38.7118,-9.1296&radiusKm=1', { token })],
  ['GET /trips/{id}', () => timed('GET', `/trips/${trip.tripId}`, { token })],
  ['GET /trips', () => timed('GET', '/trips', { token })],
  ['GET /trips/{id}/budget', () => timed('GET', `/trips/${trip.tripId}/budget`, { token })],
  ['GET /trips/{id}/recommendations', () => timed('GET', `/trips/${trip.tripId}/recommendations`, { token })],
  ['GET /trips/{id}/analytics', () => timed('GET', `/trips/${trip.tripId}/analytics`, { token })],
  ['GET /users/me/dashboard', () => timed('GET', '/users/me/dashboard', { token })],
  [
    'POST /auth/refresh',
    async () => {
      const r = await timed('POST', '/auth/refresh', { cookie });
      cookie = r.cookie;
      return r;
    },
  ],
];

const rows = [];
for (const [name, fn] of endpoints) {
  await fn(); // warm-up (connection, caches)
  const times = [];
  for (let i = 0; i < N; i += 1) times.push((await fn()).ms);
  rows.push({ name, p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), max: Math.round(Math.max(...times)) });
}

console.log(`REST latency against ${base}, ${N} sequential requests per endpoint (ms):\n`);
console.log(`${'endpoint'.padEnd(40)} ${'p50'.padStart(6)} ${'p95'.padStart(6)} ${'max'.padStart(6)}  target p95 < 200`);
for (const r of rows) {
  console.log(`${r.name.padEnd(40)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)}  ${r.p95 < 200 ? 'met' : 'MISSED'}`);
}
const all = rows.map((r) => r.p95);
console.log(`\nworst endpoint p95: ${Math.max(...all)} ms`);
console.log(JSON.stringify({ base, n: N, rows }));
