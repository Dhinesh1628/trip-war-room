// Live multi-traveller demo against a RUNNING server (spec 12.2 evidence).
// Three scripted travellers join one Trip Room, pin and move cards, collide on
// the same card, lock it, chat, and the script prints what each one saw plus
// measured sync drift.
//
// Usage: npm run demo:room              (server on http://localhost:5080)
//        npm run demo:room -- http://localhost:5080
import { io } from 'socket.io-client';

const base = (process.argv[2] || 'http://localhost:5080').replace(/\/$/, '');
const api = `${base}/api/v1`;
const stamp = Date.now();
const t0 = performance.now();
const clock = () => `${String(Math.round(performance.now() - t0)).padStart(5)} ms`;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(api + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const register = (name) =>
  call('POST', '/auth/register', {
    body: { email: `demo-${name.toLowerCase()}-${stamp}@example.test`, password: 'demo room password', displayName: name },
  });

// A traveller: one socket in the room, logging everything it receives.
function traveller(name, token, tripId) {
  return new Promise((resolve, reject) => {
    const socket = io(`${base}/trips`, { auth: { token, tripId }, transports: ['websocket'], reconnection: false });
    const t = { name, socket, received: [] };
    socket.onAny((event, msg) => {
      t.received.push({ event, msg, at: Date.now() });
      if (event === 'trip.board.update') {
        const p = msg.payload;
        console.log(`${clock()}  ${name.padEnd(5)} sees  ${p.action.padEnd(8)} ${p.item?.venue?.name ?? p.itemId}  day ${p.dayIndex ?? '-'} ${p.startTime ?? ''}  v${p.positionVersion}`);
      } else if (event === 'trip.board.rejected') {
        console.log(`${clock()}  ${name.padEnd(5)} told REJECTED (${msg.payload.reason}); board says day ${msg.payload.current.dayIndex} ${msg.payload.current.startTime} v${msg.payload.current.positionVersion}`);
      } else if (event === 'trip.chat.message') {
        console.log(`${clock()}  ${name.padEnd(5)} chat  ${msg.payload.displayName ?? 'system'}: ${msg.payload.body}`);
      } else if (event === 'trip.presence.update') {
        console.log(`${clock()}  ${name.padEnd(5)} sees  ${msg.payload.displayName} ${msg.payload.action} (${msg.payload.participantCount} online)`);
      }
    });
    socket.once('trip.sync.state', (msg) => {
      console.log(`${clock()}  ${name.padEnd(5)} joined: snapshot with ${msg.payload.items.length} items, ${msg.payload.onlineCount} online`);
      resolve(t);
    });
    socket.once('connect_error', (err) => reject(new Error(`${name}: ${err.message}`)));
    t.send = (event, payload) => socket.timeout(5000).emitWithAck(event, { event, tripId, payload, ts: Date.now() });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Demo against ${base}\n`);
const [maya, sam, priya] = await Promise.all([register('Maya'), register('Sam'), register('Priya')]);
const trip = await call('POST', '/trips', {
  token: maya.accessToken,
  body: { destination: 'Jaipur, India', startDate: '2026-12-10', endDate: '2026-12-14', totalBudget: 40000, maxParticipants: 8 },
});
await call('POST', '/trips/join', { token: sam.accessToken, body: { inviteCode: trip.inviteCode } });
await call('POST', '/trips/join', { token: priya.accessToken, body: { inviteCode: trip.inviteCode } });
console.log(`Trip ${trip.tripId}, invite code ${trip.inviteCode}\n`);

const M = await traveller('Maya', maya.accessToken, trip.tripId);
const S = await traveller('Sam', sam.accessToken, trip.tripId);
const P = await traveller('Priya', priya.accessToken, trip.tripId);
await sleep(100);

console.log('\n-- Sam pins Hawa Mahal; Priya pins dinner --');
const tour = (await S.send('trip.board.pin', { venueId: 'v_jai_012', dayIndex: 0, startTime: '15:00', endTime: '16:30' })).item;
const dinner = (await P.send('trip.board.pin', { venueId: 'v_jai_006', dayIndex: 0, startTime: '17:30', endTime: '19:00' })).item;
await sleep(100);

console.log('\n-- Sam and Priya both drag the dinner card at the same moment --');
const [s, p] = await Promise.all([
  S.send('trip.board.move', { itemId: dinner.itemId, dayIndex: 1, startTime: '19:00', endTime: '20:30', expectedVersion: 1 }),
  P.send('trip.board.move', { itemId: dinner.itemId, dayIndex: 0, startTime: '18:00', endTime: '19:30', expectedVersion: 1 }),
]);
console.log(`${clock()}  result: Sam ${s.ok ? 'WON' : `lost (${s.error.code})`}, Priya ${p.ok ? 'WON' : `lost (${p.error.code})`}`);
await sleep(100);

console.log('\n-- Maya (leader) locks Hawa Mahal --');
await M.send('trip.board.lock', { itemId: tour.itemId });
const blocked = await S.send('trip.board.move', { itemId: tour.itemId, dayIndex: 2, startTime: '15:00', endTime: '17:00', expectedVersion: 2 });
console.log(`${clock()}  Sam tries to move the locked tour: ${blocked.ok ? 'allowed (unexpected!)' : blocked.error.code}`);

console.log('\n-- Chat --');
await P.send('trip.chat.send', { body: 'Dinner right after the tour works for me' });
await sleep(150);

// ---- measurements -----------------------------------------------------------
console.log('\n-- Measured sync drift (one machine, so clocks agree) --');
const drifts = [];
for (const t of [M, S, P]) {
  for (const e of t.received) {
    if (e.event === 'trip.board.update') drifts.push(e.at - e.msg.ts);
  }
}
drifts.sort((a, b) => a - b);
const pct = (q) => drifts[Math.min(drifts.length - 1, Math.ceil(drifts.length * q) - 1)];
console.log(`board updates delivered: ${drifts.length}; server-send -> client-receive drift: median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${drifts.at(-1)} ms (target < 100 ms)`);

const pings = [];
for (let i = 0; i < 10; i += 1) {
  const sent = Date.now();
  await new Promise((resolve) => {
    S.socket.once('trip.sync.pong', () => {
      pings.push(Date.now() - sent);
      resolve();
    });
    S.socket.emit('trip.sync.ping', { event: 'trip.sync.ping', tripId: trip.tripId, payload: { clientSentAt: sent } });
  });
}
console.log(`WebSocket round trip over 10 pings: median ${pings.sort((a, b) => a - b)[4]} ms`);

const boards = [M, S, P].map((t) => {
  const last = t.received.filter((e) => e.event === 'trip.board.update' && e.msg.payload.itemId === dinner.itemId).at(-1);
  return JSON.stringify([last.msg.payload.dayIndex, last.msg.payload.startTime, last.msg.payload.positionVersion]);
});
console.log(`All three travellers agree on the dinner card: ${boards.every((b) => b === boards[0]) ? 'YES' : 'NO'} ${boards[0]}`);

// ---- analytics and recommendations (Phase 4) -----------------------------
await sleep(400); // let the background save finish
const analytics = await call('GET', `/trips/${trip.tripId}/analytics`, { token: maya.accessToken });
console.log('\n-- Session analytics (from the event log) --');
console.log(`events logged: ${analytics.eventCount}, peak online: ${analytics.peakConcurrentPlanners}, pinned: ${analytics.board.pinned}, moved: ${analytics.board.moved}, locked: ${analytics.board.locked}`);
console.log(`conflicts flagged/resolved: ${analytics.conflicts.flagged}/${analytics.conflicts.resolved}, chat messages: ${analytics.chatMessages}`);
console.log(`final budget: ${analytics.finalBudget.perPerson.map((p) => `${p.displayName} $${p.total.toFixed(2)}`).join(', ')}; group $${analytics.finalBudget.groupTotal.toFixed(2)}`);
console.log(`event log replays to the stored board exactly: ${analytics.reconciliation.reconciled ? 'YES' : `NO ${JSON.stringify(analytics.reconciliation.differences)}`}`);

const recs = await call('GET', `/trips/${trip.tripId}/recommendations`, { token: maya.accessToken });
console.log(`\n-- Recommended for the group (model trained on ${recs.model.interactions} interactions from ${recs.model.travellers} travellers) --`);
for (const r of recs.recommendations) console.log(`  ${r.name.padEnd(36)} $${String(r.pricePerPerson).padEnd(4)} ${r.why}`);

for (const t of [M, S, P]) t.socket.close();
