import request from 'supertest';
import { startTestServer, registerUser, createTrip, joinTrip } from './helpers.js';
import { joinRoom, expectRefused, sleep } from './socketHelpers.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { ItineraryItem } from '../src/board/itineraryItem.model.js';
import { ChatMessage } from '../src/chat/chatMessage.model.js';
import { User } from '../src/auth/user.model.js';

// Epic 1 acceptance criteria, exercised with real Socket.io clients against a
// real server (spec 6.1, 10.1, 10.3).

const GRACE = 150;
let server;
let app;
const open = [];

beforeAll(async () => {
  server = await startTestServer({ seed: true, env: { PRESENCE_GRACE_MS: String(GRACE), FLUSH_INTERVAL_MS: '20' } });
  app = server.app;
});

afterEach(() => {
  while (open.length) open.pop().close();
});

afterAll(async () => {
  await server.stop();
});

// Creates a trip with a leader, two planners, a viewer, an admin and an outsider.
async function setupTrip(overrides = {}) {
  const leader = await registerUser(app, { displayName: 'Leader' });
  const planner = await registerUser(app, { displayName: 'Planner A' });
  const planner2 = await registerUser(app, { displayName: 'Planner B' });
  const viewer = await registerUser(app, { displayName: 'Viewer' });
  const admin = await registerUser(app, { displayName: 'Admin', role: 'admin' });
  const outsider = await registerUser(app, { displayName: 'Outsider' });
  const trip = await createTrip(app, leader, overrides);
  await joinTrip(app, planner, trip.inviteCode);
  await joinTrip(app, planner2, trip.inviteCode);
  await joinTrip(app, viewer, trip.inviteCode);
  await request(app)
    .patch(`/api/v1/trips/${trip.tripId}/participants/${viewer.user.id}`)
    .set('Authorization', leader.auth)
    .send({ role: 'viewer' });
  return { tripId: trip.tripId, inviteCode: trip.inviteCode, leader, planner, planner2, viewer, admin, outsider };
}

async function enter(t, who) {
  const client = await joinRoom(server.url, { token: who.token, tripId: t.tripId });
  open.push(client);
  return client;
}

const slot = (dayIndex, startTime, endTime) => ({ dayIndex, startTime, endTime });

// Rebuilds a client's view of the board from its snapshot plus every update it received.
function clientBoard(client) {
  const board = new Map(client.snapshot.payload.items.map((i) => [i.itemId, i]));
  for (const e of client.events) {
    if (e.event !== 'trip.board.update') continue;
    const p = e.msg.payload;
    if (p.action === 'removed') board.delete(p.itemId);
    else board.set(p.itemId, p.item);
  }
  return board;
}

const position = (i) => ({
  dayIndex: i.dayIndex,
  startTime: i.startTime,
  endTime: i.endTime,
  lifecycleStage: i.lifecycleStage,
  positionVersion: i.positionVersion,
});

describe('handshake authentication (spec 10.1)', () => {
  let t;
  beforeAll(async () => {
    t = await setupTrip();
  });

  test('no token is refused', async () => {
    expect((await expectRefused(server.url, { tripId: t.tripId })).code).toBe('UNAUTHORIZED');
  });

  test('a forged token is refused', async () => {
    expect((await expectRefused(server.url, { token: 'not.a.jwt', tripId: t.tripId })).code).toBe('INVALID_TOKEN');
  });

  test('someone who is not in the trip is refused', async () => {
    expect((await expectRefused(server.url, { token: t.outsider.token, tripId: t.tripId })).code).toBe('FORBIDDEN');
  });

  test('an unknown trip is refused', async () => {
    const data = await expectRefused(server.url, { token: t.leader.token, tripId: '64b7f0f0f0f0f0f0f0f0f0f0' });
    expect(data.code).toBe('NOT_FOUND');
  });

  test('a participant gets a full snapshot', async () => {
    const c = await enter(t, t.planner);
    expect(c.snapshot).toMatchObject({ event: 'trip.sync.state', tripId: t.tripId });
    expect(c.snapshot.payload).toMatchObject({
      trip: { destination: 'Lisbon, Portugal', dayCount: 5, totalBudget: 1200 },
      me: { userId: t.planner.user.id, role: 'planner', muted: false },
      items: [],
      budget: { totalBudget: 1200, participantCount: 4, groupCommitted: 0 },
    });
    expect(c.snapshot.payload.participants).toHaveLength(4);
  });
});

describe('the board stays in sync (spec 6.1 acceptance)', () => {
  test('a participant joining mid-session gets every item, its stage and the budget within 2 s', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const a = (await lead.send('trip.board.pin', { venueId: 'v_lis_025', ...slot(0, '15:00', '17:00') })).item;
    await lead.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '17:30', '19:00') });
    await lead.send('trip.board.lock', { itemId: a.itemId });

    const late = await enter(t, t.planner2);
    expect(late.snapshotMs).toBeLessThan(2000);
    const items = late.snapshot.payload.items;
    expect(items.map((i) => [i.venueId, i.lifecycleStage])).toEqual([
      ['v_lis_025', 'locked'],
      ['v_lis_001', 'drafting'],
    ]);
    // 4 travellers x ($25 + $22)
    expect(late.snapshot.payload.budget).toMatchObject({ perPersonCommitted: 47, groupCommitted: 188, remaining: 1012 });
  });

  test('a pin reaches every client identically, well inside 100 ms', async () => {
    const t = await setupTrip();
    const clients = [await enter(t, t.leader), await enter(t, t.planner), await enter(t, t.viewer), await enter(t, t.planner2)];
    const sentAt = Date.now();
    const ack = await clients[1].send('trip.board.pin', { venueId: 'v_lis_017', ...slot(1, '19:00', '21:00') });
    expect(ack.ok).toBe(true);

    const received = await Promise.all(clients.map((c) => c.waitFor('trip.board.update', (m) => m.payload.itemId === ack.item.itemId)));
    const payloads = received.map((m) => m.payload);
    payloads.forEach((p) => expect(p).toEqual(payloads[0]));
    expect(payloads[0]).toMatchObject({
      action: 'pinned',
      dayIndex: 1,
      startTime: '19:00',
      lifecycleStage: 'drafting',
      positionVersion: 1,
    });
    const arrival = clients.map((c) => c.events.find((e) => e.msg?.payload?.itemId === ack.item.itemId).at);
    expect(Math.max(...arrival) - sentAt).toBeLessThan(100);
  });

  test('viewers see the board but cannot change it', async () => {
    const t = await setupTrip();
    const v = await enter(t, t.viewer);
    const res = await v.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '19:00', '20:00') });
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  test.each([
    [{ venueId: 'v_nope', ...slot(0, '19:00', '20:00') }, 'NOT_FOUND'],
    [{ venueId: 'v_lis_001', ...slot(7, '19:00', '20:00') }, 'BAD_SLOT'],
    [{ venueId: 'v_lis_001', ...slot(0, '21:00', '20:00') }, 'VALIDATION_FAILED'],
    [{ venueId: 'v_lis_001', ...slot(0, '7pm', '8pm') }, 'VALIDATION_FAILED'],
    [{ venueId: 'v_lis_001', dayIndex: 0 }, 'VALIDATION_FAILED'],
  ])('bad pin %j is rejected with %s', async (payload, code) => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const res = await p.send('trip.board.pin', payload);
    expect(res).toMatchObject({ ok: false, error: { code } });
    expect(p.count('trip.board.update')).toBe(0);
  });

  test('20 rounds of two planners moving the same item at once: one wins, the loser is told, and everyone agrees', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const a = await enter(t, t.planner);
    const b = await enter(t, t.planner2);
    const v = await enter(t, t.viewer);
    let item = (await a.send('trip.board.pin', { venueId: 'v_lis_027', ...slot(0, '10:00', '11:00') })).item;

    for (let round = 0; round < 20; round += 1) {
      const version = item.positionVersion;
      const [ra, rb] = await Promise.all([
        a.send('trip.board.move', { itemId: item.itemId, ...slot(1, '09:00', '10:00'), expectedVersion: version }),
        b.send('trip.board.move', { itemId: item.itemId, ...slot(3, '14:00', '15:00'), expectedVersion: version }),
      ]);
      const winners = [ra, rb].filter((r) => r.ok);
      const losers = [ra, rb].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].error.code).toBe('VERSION_CONFLICT');
      // The loser is handed the winning state so its UI can reconcile.
      expect(position(losers[0].current)).toEqual(position(winners[0].item));
      item = winners[0].item;
      expect(item.positionVersion).toBe(version + 1);
    }

    // Each round's loser also received an explicit trip.board.rejected event.
    expect(a.count('trip.board.rejected') + b.count('trip.board.rejected')).toBe(20);

    await sleep(50);
    const serverItem = server.gateway.registry.get(t.tripId).items.get(item.itemId);
    for (const c of [lead, a, b, v]) {
      expect(position(clientBoard(c).get(item.itemId))).toEqual(position(serverItem));
    }
    // And the database agrees after the batched save.
    await server.gateway.registry.get(t.tripId).drain();
    const saved = await ItineraryItem.findById(item.itemId).lean();
    expect(position(saved)).toEqual(position(serverItem));
    expect(saved.positionVersion).toBe(21);
  });

  test('remove needs the current version and updates the budget', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const { item } = await p.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '19:00', '20:00') });
    expect((await p.send('trip.board.remove', { itemId: item.itemId, expectedVersion: 9 })).error.code).toBe('VERSION_CONFLICT');
    expect((await p.send('trip.board.remove', { itemId: item.itemId, expectedVersion: 1 })).ok).toBe(true);
    const budget = await p.waitFor('trip.budget.update', (m) => m.payload.itemCount === 0);
    expect(budget.payload.groupCommitted).toBe(0);
    await server.gateway.registry.get(t.tripId).drain();
    expect(await ItineraryItem.countDocuments({ _id: item.itemId })).toBe(0);
  });
});

describe('locking (Leader only) and the leader override', () => {
  test('planners cannot lock; locked items cannot move; the leader can unlock', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const { item } = await p.send('trip.board.pin', { venueId: 'v_lis_028', ...slot(2, '10:00', '12:00') });

    expect((await p.send('trip.board.lock', { itemId: item.itemId })).error.code).toBe('FORBIDDEN');
    const locked = await lead.send('trip.board.lock', { itemId: item.itemId });
    expect(locked.item).toMatchObject({ lifecycleStage: 'locked', positionVersion: 2 });

    const blocked = await p.send('trip.board.move', { itemId: item.itemId, ...slot(3, '10:00', '12:00'), expectedVersion: 2 });
    expect(blocked.error.code).toBe('ITEM_LOCKED');
    expect((await p.send('trip.board.remove', { itemId: item.itemId, expectedVersion: 2 })).error.code).toBe('ITEM_LOCKED');

    const unlocked = await lead.send('trip.board.unlock', { itemId: item.itemId });
    expect(unlocked.item).toMatchObject({ lifecycleStage: 'drafting', positionVersion: 3 });
    expect((await p.send('trip.board.move', { itemId: item.itemId, ...slot(3, '10:00', '12:00'), expectedVersion: 3 })).ok).toBe(true);
  });

  test('locks are saved immediately', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const { item } = await lead.send('trip.board.pin', { venueId: 'v_lis_028', ...slot(2, '10:00', '12:00') });
    await lead.send('trip.board.lock', { itemId: item.itemId });
    await server.gateway.registry.get(t.tripId).saving;
    expect((await ItineraryItem.findById(item.itemId).lean()).lifecycleStage).toBe('locked');
  });

  test('a token that expires mid-session cannot lock until it is renewed', async () => {
    const t = await setupTrip();
    const leaderDoc = await User.findById(t.leader.user.id);
    const shortToken = signAccessToken(leaderDoc, { ...server.config, accessTokenTtlSeconds: 1 });
    const lead = await joinRoom(server.url, { token: shortToken, tripId: t.tripId });
    open.push(lead);
    const { item } = await lead.send('trip.board.pin', { venueId: 'v_lis_028', ...slot(2, '10:00', '12:00') });
    await sleep(1100);
    expect((await lead.send('trip.board.lock', { itemId: item.itemId })).error.code).toBe('TOKEN_EXPIRED');
    expect((await lead.send('auth.renew', { token: t.leader.token })).ok).toBe(true);
    expect((await lead.send('trip.board.lock', { itemId: item.itemId })).ok).toBe(true);
  });
});

describe('leader disconnected state (spec 6.1 acceptance)', () => {
  test('when the leader drops, the room shows it and lock actions freeze until they return', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const admin = await enter(t, t.admin);
    const p = await enter(t, t.planner);
    const { item } = await p.send('trip.board.pin', { venueId: 'v_lis_028', ...slot(2, '10:00', '12:00') });
    expect(p.snapshot.payload.leader.connected).toBe(true);

    lead.close();
    const away = await p.waitFor('trip.leader.status', (m) => m.payload.connected === false);
    expect(away.payload).toMatchObject({ leaderUserId: t.leader.user.id, frozenActions: ['lock', 'unlock'] });
    expect(away.payload.awaySince).toEqual(expect.any(String));

    // Even an admin cannot lock while the leader is away (deterministic freeze).
    expect((await admin.send('trip.board.lock', { itemId: item.itemId })).error.code).toBe('LEADER_DISCONNECTED');
    // Planning itself carries on.
    expect((await p.send('trip.board.move', { itemId: item.itemId, ...slot(1, '10:00', '12:00'), expectedVersion: 1 })).ok).toBe(true);

    const back = await enter(t, t.leader);
    expect(back.snapshot.payload.leader.connected).toBe(true);
    await p.waitFor('trip.leader.status', (m) => m.payload.connected === true);
    expect((await admin.send('trip.board.lock', { itemId: item.itemId })).ok).toBe(true);
  });

  test('a leader who reconnects inside the grace window never triggers the disconnected state', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const lead = await enter(t, t.leader);
    // Let the planner receive the leader's arrival notices first.
    await p.waitFor('trip.leader.status', (m) => m.payload.connected === true);
    await p.waitFor('trip.presence.update', (m) => m.payload.action === 'joined');
    const mark = p.events.length; // everything after this index happened after the drop
    lead.close();
    await sleep(GRACE / 3);
    await enter(t, t.leader);
    await sleep(GRACE * 2);
    const after = p.events.slice(mark).map((e) => e.event);
    expect(after).not.toContain('trip.leader.status');
    expect(after).not.toContain('trip.presence.update');
  });
});

describe('presence and reconnects', () => {
  test('others see joins and leaves with a live count', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const joined = await lead.waitFor('trip.presence.update', (m) => m.payload.action === 'joined');
    expect(joined.payload).toMatchObject({ participantId: t.planner.user.id, participantCount: 2, displayName: 'Planner A' });

    p.close();
    const left = await lead.waitFor('trip.presence.update', (m) => m.payload.action === 'left');
    expect(left.payload).toMatchObject({ participantId: t.planner.user.id, participantCount: 1 });
  });

  test('two tabs for one person count once; closing one tab is not a leave', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const tab1 = await enter(t, t.planner);
    const tab2 = await enter(t, t.planner);
    expect(tab2.snapshot.payload.onlineCount).toBe(2);
    tab1.close();
    await sleep(GRACE * 2);
    expect(lead.count('trip.presence.update', (m) => m.payload.action === 'left')).toBe(0);
    expect(lead.count('trip.presence.update', (m) => m.payload.action === 'joined')).toBe(1);
    expect(tab2.socket.connected).toBe(true);
  });

  test('a quick reconnect resyncs the board and chat without a duplicate join', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    await p.send('trip.chat.send', { body: 'before the drop' });
    p.close();
    await lead.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '19:00', '20:00') });
    const again = await enter(t, t.planner);
    expect(again.snapshot.payload.items).toHaveLength(1);
    expect(again.snapshot.payload.chat.map((m) => m.body)).toContain('before the drop');
    await sleep(GRACE * 2);
    expect(lead.count('trip.presence.update', (m) => m.payload.action === 'joined')).toBe(1);
    expect(lead.count('trip.presence.update', (m) => m.payload.action === 'left')).toBe(0);
  });

  test('connection quality reports are shared with the room', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    expect((await p.send('trip.sync.report', { rttMs: 520 })).quality).toBe('poor');
    const q = await lead.waitFor('trip.presence.quality');
    expect(q.payload).toEqual({ participantId: t.planner.user.id, rttMs: 520, quality: 'poor' });
  });

  test('ping/pong returns server receive time for latency measurement', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const clientSentAt = Date.now();
    p.socket.emit('trip.sync.ping', { event: 'trip.sync.ping', tripId: t.tripId, payload: { clientSentAt } });
    const pong = await p.waitFor('trip.sync.pong');
    expect(pong.payload.clientSentAt).toBe(clientSentAt);
    expect(pong.payload.serverReceivedAt).toBeGreaterThanOrEqual(clientSentAt);
  });

  test('when everyone leaves, the room is saved and unloaded, and reloads intact from the database', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const { item } = await p.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '19:00', '20:00') });
    await p.send('trip.board.move', { itemId: item.itemId, ...slot(4, '12:00', '13:30'), expectedVersion: 1 });
    p.close();
    await sleep(GRACE + 150);
    expect(server.gateway.registry.get(t.tripId)).toBeUndefined();

    const back = await enter(t, t.planner);
    expect(position(back.snapshot.payload.items[0])).toEqual({
      dayIndex: 4,
      startTime: '12:00',
      endTime: '13:30',
      lifecycleStage: 'drafting',
      positionVersion: 2,
    });
  });

  test('rooms are isolated from each other', async () => {
    const t1 = await setupTrip();
    const t2 = await setupTrip();
    const a = await enter(t1, t1.planner);
    const b = await enter(t2, t2.planner);
    await a.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '19:00', '20:00') });
    await a.send('trip.chat.send', { body: 'only for trip 1' });
    await sleep(50);
    expect(b.count('trip.board.update')).toBe(0);
    expect(b.count('trip.chat.message')).toBe(0);
  });
});

describe('chat', () => {
  test('messages reach everyone, are saved, and appear in the next snapshot', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const v = await enter(t, t.viewer);
    const ack = await v.send('trip.chat.send', { body: 'Viewers can chat too' });
    expect(ack.ok).toBe(true);
    const msg = await lead.waitFor('trip.chat.message');
    expect(msg.payload).toMatchObject({
      userId: t.viewer.user.id,
      displayName: 'Viewer',
      type: 'chat',
      body: 'Viewers can chat too',
      tsSeconds: expect.any(Number),
    });
    expect(await ChatMessage.countDocuments({ tripId: t.tripId })).toBe(1);
    const later = await enter(t, t.planner);
    expect(later.snapshot.payload.chat.map((m) => m.body)).toEqual(['Viewers can chat too']);
  });

  test('HTML is stripped before saving (stored XSS defence)', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const ack = await p.send('trip.chat.send', { body: '<img src=x onerror=alert(1)>Dinner at 8?' });
    expect(ack.message.body).toBe('Dinner at 8?');
    expect((await ChatMessage.findById(ack.message.messageId)).body).toBe('Dinner at 8?');
  });

  test.each([
    ['', 'empty'],
    ['   ', 'only spaces'],
    ['<b></b>', 'only tags'],
    ['x'.repeat(1001), 'over 1000 characters'],
  ])('rejects %j (%s)', async (body) => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    expect((await p.send('trip.chat.send', { body })).ok).toBe(false);
  });

  test('a resend with the same client message id is not duplicated', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const first = await p.send('trip.chat.send', { body: 'once', clientMsgId: 'm-1' });
    const second = await p.send('trip.chat.send', { body: 'once', clientMsgId: 'm-1' });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(second.message.messageId).toBe(first.message.messageId);
    await sleep(50);
    expect(lead.count('trip.chat.message')).toBe(1);
  });

  test('typing indicators go to everyone else, not back to the typist', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    await p.send('trip.chat.typing', { isTyping: true });
    const typing = await lead.waitFor('trip.chat.typing');
    expect(typing.payload).toEqual({ userId: t.planner.user.id, displayName: 'Planner A', isTyping: true });
    await sleep(30);
    expect(p.count('trip.chat.typing')).toBe(0);
  });

  test('reactions toggle on and off and only allowed emoji are accepted', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const { message } = await lead.send('trip.chat.send', { body: 'Sunset sail on day 2?' });
    const on = await p.send('trip.chat.react', { messageId: message.messageId, emoji: '👍' });
    expect(on.reactions).toEqual({ '👍': [t.planner.user.id] });
    const seen = await lead.waitFor('trip.chat.reaction');
    expect(seen.payload.reactions).toEqual({ '👍': [t.planner.user.id] });
    const off = await p.send('trip.chat.react', { messageId: message.messageId, emoji: '👍' });
    expect(off.reactions).toEqual({});
    expect((await p.send('trip.chat.react', { messageId: message.messageId, emoji: '<b>' })).ok).toBe(false);
  });

  test('history can be paged backwards', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    for (let i = 1; i <= 5; i += 1) await p.send('trip.chat.send', { body: `m${i}` });
    const page = await p.send('trip.chat.history', { limit: 2 });
    expect(page.messages.map((m) => m.body)).toEqual(['m4', 'm5']);
    const older = await p.send('trip.chat.history', { limit: 2, before: page.messages[0].createdAt });
    expect(older.messages.map((m) => m.body)).toEqual(['m2', 'm3']);
  });
});

describe('leader moderation (spec 6.1)', () => {
  test('only the leader can moderate', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    for (const [event, payload] of [
      ['trip.mod.mute', { userId: t.viewer.user.id, muted: true }],
      ['trip.mod.remove', { userId: t.viewer.user.id }],
      ['trip.mod.lockRoom', { locked: true }],
      ['trip.mod.transferLeader', { userId: t.planner.user.id }],
    ]) {
      expect((await p.send(event, payload)).error.code).toBe('FORBIDDEN');
    }
  });

  test('mute stops a traveller chatting until unmuted', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    expect((await lead.send('trip.mod.mute', { userId: t.planner.user.id, muted: true })).ok).toBe(true);
    await p.waitFor('trip.participant.updated', (m) => m.payload.muted === true);
    expect((await p.send('trip.chat.send', { body: 'hello?' })).error.code).toBe('MUTED');
    const notice = await p.waitFor('trip.chat.message', (m) => m.payload.type === 'system');
    expect(notice.payload.body).toBe('Planner A was muted by the trip leader');
    await lead.send('trip.mod.mute', { userId: t.planner.user.id, muted: false });
    expect((await p.send('trip.chat.send', { body: 'back' })).ok).toBe(true);
  });

  test('the leader cannot be muted or removed, and cannot target themselves', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const admin = await enter(t, t.admin);
    expect((await admin.send('trip.mod.mute', { userId: t.leader.user.id, muted: true })).error.code).toBe('FORBIDDEN');
    expect((await admin.send('trip.mod.remove', { userId: t.leader.user.id })).error.code).toBe('FORBIDDEN');
    expect((await lead.send('trip.mod.mute', { userId: t.leader.user.id, muted: true })).ok).toBe(false);
  });

  test('a removed traveller is disconnected and cannot come back', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const disconnected = new Promise((resolve) => p.socket.once('disconnect', resolve));
    expect((await lead.send('trip.mod.remove', { userId: t.planner.user.id })).ok).toBe(true);
    await p.waitFor('trip.participant.removed');
    await disconnected;

    const left = await lead.waitFor('trip.presence.update', (m) => m.payload.action === 'left');
    expect(left.payload.participantId).toBe(t.planner.user.id);
    const budget = await lead.waitFor('trip.budget.update', (m) => m.payload.participantCount === 3);
    expect(budget.payload.participantCount).toBe(3);

    expect((await expectRefused(server.url, { token: t.planner.token, tripId: t.tripId })).code).toBe('FORBIDDEN');
    expect((await joinTrip(app, t.planner, t.inviteCode)).status).toBe(403);
  });

  test('a locked room refuses new travellers until unlocked', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    expect((await lead.send('trip.mod.lockRoom', { locked: true })).ok).toBe(true);
    await lead.waitFor('trip.room.locked', (m) => m.payload.locked === true);
    const res = await joinTrip(app, t.outsider, t.inviteCode);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROOM_LOCKED');
    await lead.send('trip.mod.lockRoom', { locked: false });
    expect((await joinTrip(app, t.outsider, t.inviteCode)).status).toBe(201);
  });

  test('transferring the leader role swaps who can lock', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const { item } = await p.send('trip.board.pin', { venueId: 'v_lis_028', ...slot(2, '10:00', '12:00') });
    expect((await lead.send('trip.mod.transferLeader', { userId: t.planner.user.id })).ok).toBe(true);
    const status = await p.waitFor('trip.leader.status', (m) => m.payload.leaderUserId === t.planner.user.id);
    expect(status.payload.connected).toBe(true);

    expect((await lead.send('trip.board.lock', { itemId: item.itemId })).error.code).toBe('FORBIDDEN');
    expect((await p.send('trip.board.lock', { itemId: item.itemId })).ok).toBe(true);
    const trip = await request(app).get(`/api/v1/trips/${t.tripId}`).set('Authorization', t.planner.auth);
    expect(trip.body.trip).toMatchObject({ leaderUserId: t.planner.user.id, myRole: 'leader' });
  });

  test('a role change made over REST applies to an open connection straight away', async () => {
    const t = await setupTrip();
    const v = await enter(t, t.viewer);
    expect((await v.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '19:00', '20:00') })).ok).toBe(false);
    await request(app)
      .patch(`/api/v1/trips/${t.tripId}/participants/${t.viewer.user.id}`)
      .set('Authorization', t.leader.auth)
      .send({ role: 'planner' });
    await v.waitFor('trip.participants.update');
    expect((await v.send('trip.board.pin', { venueId: 'v_lis_001', ...slot(0, '19:00', '20:00') })).ok).toBe(true);
  });
});
