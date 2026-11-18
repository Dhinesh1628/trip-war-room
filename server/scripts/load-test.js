// Load test of the Board Sync Gateway (spec 11.1 week 4, 10.2).
// Starts N scripted travellers in each of R Trip Rooms on a RUNNING server,
// has them pin, move (including deliberate simultaneous moves on the same
// card) and chat, then reports:
//   - sync drift: server send time -> client receive time, per delivery
//   - fan-out: first -> last client delivery of the same event in a room
//   - ack latency: client send -> server acknowledgement
//   - concurrent-move outcomes and whether every client ends with the same board
// All clients run on this machine, so their clocks agree with the server's.
//
// Usage: npm run load-test -- [baseUrl] [travellersPerRoom=8] [rooms=2] [rounds=25]
import { io } from 'socket.io-client';

const [base = 'http://localhost:5080', perRoomArg = '8', roomsArg = '2', roundsArg = '25'] = process.argv.slice(2);
const PER_ROOM = Number(perRoomArg);
const ROOMS = Number(roomsArg);
const ROUNDS = Number(roundsArg);
const api = `${base.replace(/\/$/, '')}/api/v1`;
const stamp = Date.now().toString(36);

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

const pct = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)];
};
const summary = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99), max: xs.length ? Math.max(...xs) : null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const drift = [];
const acks = [];
const fanout = [];
const deliveries = new Map(); // `${tripId}|${ts}|${itemId}|${version}` -> [receive times]
let conflictsWon = 0;
let conflictsLost = 0;
let errors = 0;
const errorCodes = {};
const fail = (r) => {
  errors += 1;
  errorCodes[r.error?.code ?? 'UNKNOWN'] = (errorCodes[r.error?.code ?? 'UNKNOWN'] ?? 0) + 1;
};

function connect(token, tripId) {
  return new Promise((resolve, reject) => {
    const socket = io(`${base}/trips`, { auth: { token, tripId }, transports: ['websocket'], reconnection: false, forceNew: true });
    const board = new Map();
    socket.on('trip.sync.state', (m) => {
      for (const i of m.payload.items) board.set(i.itemId, i);
      resolve({ socket, board, tripId });
    });
    socket.on('trip.board.update', (m) => {
      const now = Date.now();
      drift.push(now - m.ts);
      const p = m.payload;
      const key = `${tripId}|${m.ts}|${p.itemId}|${p.positionVersion}`;
      if (!deliveries.has(key)) deliveries.set(key, []);
      deliveries.get(key).push(now);
      if (p.action === 'removed') board.delete(p.itemId);
      else board.set(p.itemId, p.item);
    });
    socket.on('connect_error', (e) => reject(e));
  });
}

async function send(client, event, payload) {
  const t = performance.now();
  const ack = await client.socket.timeout(10000).emitWithAck(event, { event, tripId: client.tripId, payload, ts: Date.now() });
  acks.push(performance.now() - t);
  return ack;
}

console.log(`Load test: ${ROOMS} room(s) x ${PER_ROOM} travellers, ${ROUNDS} rounds, against ${base}`);
const setupStart = performance.now();
const rooms = [];
for (let r = 0; r < ROOMS; r += 1) {
  const people = [];
  for (let i = 0; i < PER_ROOM; i += 1) {
    people.push(
      await call('POST', '/auth/register', {
        body: { email: `load-${stamp}-r${r}-p${i}@example.test`, password: 'load test password', displayName: `Load ${r}.${i}` },
      }),
    );
  }
  const trip = await call('POST', '/trips', {
    token: people[0].accessToken,
    body: { destination: 'lisbon', startDate: '2026-12-10', endDate: '2026-12-14', totalBudget: 50000, maxParticipants: 50 },
  });
  for (const p of people.slice(1)) await call('POST', '/trips/join', { token: p.accessToken, body: { inviteCode: trip.inviteCode } });
  const clients = await Promise.all(people.map((p) => connect(p.accessToken, trip.tripId)));
  rooms.push({ trip, clients });
}
console.log(`setup: ${Math.round(performance.now() - setupStart)} ms (accounts, trips, ${ROOMS * PER_ROOM} connections)\n`);

const venues = ['v_lis_001', 'v_lis_002', 'v_lis_017', 'v_lis_025', 'v_lis_027', 'v_lis_028', 'v_lis_030', 'v_lis_033'];
const testStart = performance.now();
await Promise.all(
  rooms.map(async ({ clients }) => {
    // Each room: one shared card that two planners fight over every round,
    // plus a stream of pins and chat from everyone else.
    const shared = (await send(clients[0], 'trip.board.pin', { venueId: 'v_lis_031', dayIndex: 0, startTime: '10:00', endTime: '11:00' })).item;
    let version = shared.positionVersion;
    // Background pins each get their own early-morning start time, so they
    // never land in the exact same slot (which would rightly open a vote).
    // Slot n: day n % 5, starting at 00:00 + floor(n / 5) minutes. Room for
    // 5 x 600 pins before reaching the shared card at 10:00.
    let slot = 0;
    const nextSlot = () => {
      const n = slot++;
      const m = Math.floor(n / 5);
      const hh = (x) => String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
      return { dayIndex: n % 5, startTime: hh(m), endTime: hh(m + 1) };
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      const a = clients[1 % clients.length];
      const b = clients[2 % clients.length];
      const [ra, rb] = await Promise.all([
        send(a, 'trip.board.move', { itemId: shared.itemId, dayIndex: round % 5, startTime: '10:00', endTime: '11:00', expectedVersion: version }),
        send(b, 'trip.board.move', { itemId: shared.itemId, dayIndex: (round + 2) % 5, startTime: '12:00', endTime: '13:00', expectedVersion: version }),
      ]);
      for (const r of [ra, rb]) {
        if (r.ok) {
          conflictsWon += 1;
          version = r.item.positionVersion;
        } else if (r.error.code === 'VERSION_CONFLICT') conflictsLost += 1;
        else fail(r);
      }
      // Everyone else does something at the same time.
      await Promise.all(
        clients.slice(3).map((c, k) =>
          k % 2
            ? send(c, 'trip.chat.send', { body: `round ${round} from ${k}` })
            : send(c, 'trip.board.pin', { venueId: venues[(round + k) % venues.length], ...nextSlot() }),
        ),
      ).then((rs) => rs.forEach((r) => !r.ok && fail(r)));
    }
  }),
);
const testMs = performance.now() - testStart;
await sleep(500);

for (const times of deliveries.values()) if (times.length > 1) fanout.push(Math.max(...times) - Math.min(...times));

// Every client in a room must hold exactly the same board.
let agree = true;
for (const { clients } of rooms) {
  const sig = (c) => JSON.stringify([...c.board.values()].map((i) => [i.itemId, i.dayIndex, i.startTime, i.positionVersion]).sort());
  if (!clients.every((c) => sig(c) === sig(clients[0]))) agree = false;
}

const result = {
  config: { rooms: ROOMS, travellersPerRoom: PER_ROOM, rounds: ROUNDS, base },
  durationMs: Math.round(testMs),
  boardUpdatesDelivered: drift.length,
  syncDriftMs: summary(drift),
  fanoutSpreadMs: summary(fanout),
  ackLatencyMs: summary(acks.map(Math.round)),
  concurrentMoves: { rounds: ROUNDS * ROOMS, applied: conflictsWon, rejectedAsConflict: conflictsLost },
  otherErrors: errors,
  errorCodes,
  allClientsAgree: agree,
};
console.log(JSON.stringify(result, null, 2));
console.log(
  `\nsync drift p95 ${result.syncDriftMs.p95} ms (target < 100) | fan-out p95 ${result.fanoutSpreadMs.p95} ms (target < 500) | ` +
    `every simultaneous pair: 1 applied + 1 rejected = ${conflictsWon === ROUNDS * ROOMS && conflictsLost === ROUNDS * ROOMS ? 'YES' : 'NO'} | boards agree: ${agree ? 'YES' : 'NO'}`,
);
for (const { clients } of rooms) for (const c of clients) c.socket.close();
process.exitCode = agree && errors === 0 ? 0 : 1;
