// End-to-end smoke test against a RUNNING server (not the test database).
// Walks the Phase 1 flow and prints one line per check.
// Usage: npm run smoke            (defaults to http://localhost:5080)
//        npm run smoke -- http://localhost:5080
// It creates two throwaway accounts and one trip each time it runs.

const base = `${(process.argv[2] || 'http://localhost:5080').replace(/\/$/, '')}/api/v1`;
let failures = 0;
const timings = [];

function check(label, ok, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
}

// Minimal client that keeps one refresh cookie, like a browser would.
function client() {
  let cookie = '';
  return async function call(method, path, { token, body } = {}) {
    const started = performance.now();
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    timings.push(performance.now() - started);
    const set = res.headers.getSetCookie?.() ?? [];
    const refresh = set.find((c) => c.startsWith('twr_refresh='));
    if (refresh) cookie = refresh.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const stamp = Date.now();
const password = 'smoke test password';
const leader = client();
const friend = client();

const health = await leader('GET', '/health');
check('API health', health.status === 200 && health.body.db === 'connected', `db=${health.body?.db}`);

const reg = await leader('POST', '/auth/register', {
  body: { email: `smoke-leader-${stamp}@example.test`, password, displayName: 'Smoke Leader' },
});
check('register leader', reg.status === 201, `status ${reg.status}`);
let leaderToken = reg.body.accessToken;

const bad = await leader('POST', '/auth/login', { body: { email: `smoke-leader-${stamp}@example.test`, password: 'wrong one' } });
check('wrong password rejected', bad.status === 401);

const refreshed = await leader('POST', '/auth/refresh');
check('refresh via cookie', refreshed.status === 200);
leaderToken = refreshed.body.accessToken;

const near = await leader('GET', '/destinations/jaipur/venues?near=26.9239,75.8267&radiusKm=1', { token: leaderToken });
check(
  'venues within 1 km of Hawa Mahal',
  near.status === 200 && near.body.count > 0 && near.body.venues.every((v) => v.distanceKm <= 1),
  `${near.body?.count} venues`,
);

const trip = await leader('POST', '/trips', {
  token: leaderToken,
  body: { destination: 'Jaipur, India', startDate: '2026-12-10', endDate: '2026-12-14', totalBudget: 40000, maxParticipants: 8 },
});
check('create trip', trip.status === 201 && /^[A-Z2-9]{2}-[A-Z2-9]{4}$/.test(trip.body.inviteCode), trip.body?.inviteCode);
const { tripId, inviteCode } = trip.body;

const freg = await friend('POST', '/auth/register', {
  body: { email: `smoke-friend-${stamp}@example.test`, password, displayName: 'Smoke Friend' },
});
const friendToken = freg.body.accessToken;
const friendId = freg.body.user.id;

const joined = await friend('POST', '/trips/join', { token: friendToken, body: { inviteCode } });
check('friend joins by invite code', joined.status === 201 && joined.body.trip.myRole === 'planner');

const demoted = await leader('PATCH', `/trips/${tripId}/participants/${friendId}`, { token: leaderToken, body: { role: 'viewer' } });
check('leader makes friend a viewer', demoted.status === 200);

const asViewer = await friend('GET', `/trips/${tripId}`, { token: friendToken });
check('viewer can read the trip', asViewer.status === 200 && asViewer.body.trip.myRole === 'viewer');
check('viewer cannot see the invite code', asViewer.status === 200 && !('inviteCode' in asViewer.body.trip));

const settings = await friend('PATCH', `/trips/${tripId}/settings`, { token: friendToken, body: { maxParticipants: 20 } });
check('viewer blocked from leader-only settings', settings.status === 403, `status ${settings.status}`);

const admin = await leader('GET', '/admin/datasets', { token: leaderToken });
check('leader blocked from admin-only datasets', admin.status === 403, `status ${admin.status}`);

const anon = await client()('GET', `/trips/${tripId}`);
check('no token rejected', anon.status === 401);

const out = await leader('POST', '/auth/logout');
const after = await leader('POST', '/auth/refresh');
check('logout revokes refresh token', out.status === 204 && after.status === 401);

const sorted = [...timings].sort((a, b) => a - b);
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
console.log(`\n${timings.length} requests, median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
console.log(failures ? `${failures} check(s) FAILED` : 'All checks passed');
process.exitCode = failures ? 1 : 0;
