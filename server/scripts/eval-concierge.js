// Asks the running server's Concierge a fixed set of questions and checks
// every answer against the venue data (spec 6.2 compliance, 10.2 latency).
//
// Usage: npm run eval:concierge                 (server on http://localhost:5080)
//        npm run eval:concierge -- http://localhost:5080
//
// COST: if the server has ANTHROPIC_API_KEY set, every question with at least
// one valid venue is one Claude API call (about 12 calls per run).
import { io } from 'socket.io-client';

const base = (process.argv[2] || 'http://localhost:5080').replace(/\/$/, '');
const api = `${base}/api/v1`;
const stamp = Date.now();

async function call(method, path, { token, body } = {}) {
  const res = await fetch(api + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const R = 6371.0088;
const km = (a, b) => {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
function openFor(hours, from, to) {
  if (hours.open === '00:00' && hours.close === '23:59') return true;
  const o = mins(hours.open);
  let c = mins(hours.close);
  if (c <= o) c += 1440;
  let s = mins(from);
  let e = mins(to);
  if (e <= s) e += 1440;
  return [0, 1440].some((shift) => s + shift >= o && e + shift <= c);
}

// Re-checks a suggestion against the rules the server says it applied.
function breaks(v, c) {
  const out = [];
  if (c.category && v.category !== c.category) out.push('category');
  if (c.maxPricePerPerson != null && v.pricePerPerson > c.maxPricePerPerson) out.push('budget');
  const food = ['breakfast', 'lunch', 'dinner', 'cafe', 'bar'].includes(v.category);
  if (food && c.dietaryTags.some((t) => !v.dietaryTags.includes(t))) out.push('dietary');
  if (c.mustBeOpen && !openFor(v.hours, c.mustBeOpen.from, c.mustBeOpen.to)) out.push('hours');
  if (c.anchor && km(c.anchor.coordinates, v.coordinates) > c.radiusKm) out.push('proximity');
  return out;
}

const QUESTIONS = [
  'Suggest a lunch spot near our 9 AM heritage walk under ₹500/person',
  'vegetarian lunch near our 9 AM heritage walk',
  'a vegan lunch under ₹600',
  'veg breakfast at 8am',
  'halal dinner within 2 km of our heritage walk',
  'a bar at 9 pm',
  'cheap hotel under ₹2,000',
  'a museum to visit on day 2',
  'chai near the fort',
  'dinner at 21:00 under ₹1,500, gluten free',
  'kosher lunch under ₹500',
  'something to do near our heritage walk',
];

console.log(`Concierge evaluation against ${base}\n`);
const reg = await call('POST', '/auth/register', {
  body: { email: `eval-${stamp}@example.test`, password: 'concierge eval password', displayName: 'Eval' },
});
const token = reg.body.accessToken;
const trip = (
  await call('POST', '/trips', {
    token,
    body: { destination: 'jaipur', startDate: '2026-12-10', endDate: '2026-12-14', totalBudget: 60000, maxParticipants: 4 },
  })
).body;

// Pin the 9 AM Pink City heritage walk and Amber Fort, so questions have anchors.
const socket = io(`${base}/trips`, { auth: { token, tripId: trip.tripId }, transports: ['websocket'] });
await new Promise((r) => socket.once('trip.sync.state', r));
const pin = (p) => socket.timeout(5000).emitWithAck('trip.board.pin', { payload: p });
await pin({ venueId: 'v_jai_017', dayIndex: 0, startTime: '09:00', endTime: '11:00' });
await pin({ venueId: 'v_jai_010', dayIndex: 1, startTime: '10:00', endTime: '12:00' });

const venues = new Map(
  (await call('GET', '/destinations/jaipur/venues', { token })).body.venues.map((v) => [v.venueId, v]),
);

const rows = [];
for (const question of QUESTIONS) {
  const started = performance.now();
  const res = await call('POST', `/trips/${trip.tripId}/ai/ask`, { token, body: { question } });
  const wall = Math.round(performance.now() - started);
  if (res.status !== 200) {
    rows.push({ question, status: res.status, error: res.body?.error?.code });
    continue;
  }
  const b = res.body;
  const v = b.suggestedVenueId ? venues.get(b.suggestedVenueId) : null;
  const bad = v ? breaks(v, b.constraints) : [];
  const invented = b.suggestedVenueId && !v;
  rows.push({
    question,
    mode: b.mode + (b.fallbackReason ? ` (${b.fallbackReason})` : ''),
    suggestion: v ? `${v.name} $${v.pricePerPerson}` : '(none)',
    valid: invented ? 'INVENTED VENUE' : bad.length ? `BREAKS ${bad.join(',')}` : 'ok',
    serverMs: b.latencyMs,
    wallMs: wall,
    answer: b.answer,
  });
}
socket.close();

for (const r of rows) {
  console.log(`Q: ${r.question}`);
  if (r.error) {
    console.log(`   HTTP ${r.status} ${r.error}\n`);
    continue;
  }
  console.log(`   ${r.mode} | ${r.suggestion} | rules: ${r.valid} | ${r.wallMs} ms`);
  console.log(`   ${r.answer}\n`);
}

const answered = rows.filter((r) => !r.error);
const lat = answered.map((r) => r.wallMs).sort((a, b) => a - b);
const pct = (q) => lat[Math.min(lat.length - 1, Math.ceil(lat.length * q) - 1)];
const suggestions = answered.filter((r) => r.suggestion !== '(none)');
const compliant = suggestions.filter((r) => r.valid === 'ok');
const modes = answered.reduce((m, r) => ((m[r.mode] = (m[r.mode] || 0) + 1), m), {});
console.log('Summary');
console.log(`  questions: ${rows.length}, answered: ${answered.length}, with a suggestion: ${suggestions.length}`);
console.log(`  constraint compliance: ${compliant.length}/${suggestions.length}`);
console.log(`  modes: ${JSON.stringify(modes)}`);
console.log(`  latency (end to end): median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${lat.at(-1)} ms (target p95 < 3000 ms)`);
process.exitCode = compliant.length === suggestions.length ? 0 : 1;
