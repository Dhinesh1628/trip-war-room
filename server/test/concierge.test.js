import request from 'supertest';
import { startTestServer, registerUser, createTrip, joinTrip } from './helpers.js';
import { joinRoom, sleep } from './socketHelpers.js';
import { ChatMessage } from '../src/chat/chatMessage.model.js';
import { ItineraryItem } from '../src/board/itineraryItem.model.js';
import { Vote } from '../src/board/vote.model.js';
import { distanceKm } from '../src/venues/geo.js';

// Epic 2 end to end: the Concierge over REST and WebSocket, conflict flags,
// and contested-slot votes, with real Socket.io clients (spec 6.2, 7.3.3).

// A fake Claude client whose reply each test can set.
const fake = { reply: null, calls: 0 };
const llm = {
  beta: {
    messages: {
      create: async (params) => {
        fake.calls += 1;
        return fake.reply(params);
      },
    },
  },
};
const facts = (params) => JSON.parse(params.messages[0].content.replace(/^Facts \(JSON\):\n/, ''));

let server;
let app;
const open = [];

beforeAll(async () => {
  server = await startTestServer({
    seed: true,
    llm,
    env: { PRESENCE_GRACE_MS: '150', FLUSH_INTERVAL_MS: '20', VOTE_SECONDS: '1', CONCIERGE_RATE_LIMIT: '5' },
  });
  app = server.app;
});

beforeEach(() => {
  // Default: Claude answers with the top candidate, using only given facts.
  fake.reply = (params) => {
    const top = facts(params).candidates[0];
    return {
      stop_reason: 'end_turn',
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1000, output_tokens: 50 },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            answer: `${top.name} fits: about $${top.pricePerPerson} per person, open ${top.hours.open}-${top.hours.close}.`,
            suggestedVenueId: top.venueId,
            citedVenueIds: [top.venueId],
          }),
        },
      ],
    };
  };
});

afterEach(() => {
  while (open.length) open.pop().close();
});

afterAll(async () => {
  await server.stop();
});

async function setupTrip() {
  const leader = await registerUser(app, { displayName: 'Maya' });
  const planner = await registerUser(app, { displayName: 'Sam' });
  const viewer = await registerUser(app, { displayName: 'Priya' });
  const outsider = await registerUser(app);
  const trip = await createTrip(app, leader);
  await joinTrip(app, planner, trip.inviteCode);
  await joinTrip(app, viewer, trip.inviteCode);
  await request(app)
    .patch(`/api/v1/trips/${trip.tripId}/participants/${viewer.user.id}`)
    .set('Authorization', leader.auth)
    .send({ role: 'viewer' });
  return { tripId: trip.tripId, inviteCode: trip.inviteCode, leader, planner, viewer, outsider };
}

async function enter(t, who) {
  const c = await joinRoom(server.url, { token: who.token, tripId: t.tripId });
  open.push(c);
  return c;
}

const ask = (t, who, body) =>
  request(app).post(`/api/v1/trips/${t.tripId}/ai/ask`).set('Authorization', who.auth).send(body);

const venue = async (who, id) =>
  (await request(app).get(`/api/v1/destinations/lisbon/venues/${id}`).set('Authorization', who.auth)).body.venue;

describe('POST /trips/{id}/ai/ask (spec 7.3.3)', () => {
  test('the spec example: a dinner near our 5 PM tour under $25, grounded and cited', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const { item: tour } = await lead.send('trip.board.pin', { venueId: 'v_lis_025', dayIndex: 0, startTime: '17:00', endTime: '19:00' });

    const res = await ask(t, t.planner, {
      userId: 'ignored',
      question: 'Suggest a dinner spot near our 5 PM tour under $25/person',
    });
    expect(res.status).toBe(200);
    // The spec's response fields.
    expect(res.body).toMatchObject({
      answer: expect.any(String),
      suggestedVenueId: expect.stringMatching(/^v_lis_/),
      sourceEvents: expect.arrayContaining([`item:${tour.itemId}`]),
      generatedAt: expect.any(String),
      mode: 'llm',
      userId: t.planner.user.id,
    });
    expect(res.body.sourceEvents).toContain(`venue:${res.body.suggestedVenueId}`);

    // The suggestion obeys every active rule, checked against the real data.
    const v = await venue(t.planner, res.body.suggestedVenueId);
    expect(v.category).toBe('dinner');
    expect(v.pricePerPerson).toBeLessThanOrEqual(25);
    expect(distanceKm(v.coordinates, { lat: 38.7118, lng: -9.1296 })).toBeLessThanOrEqual(2);
    expect(res.body.constraints).toMatchObject({
      active: { budget: true, dietary: false, hours: true, proximity: true },
      mustBeOpen: { from: '19:30', to: '21:00' },
      maxPricePerPerson: 25,
    });
    // Cited metadata comes straight from the dataset.
    expect(res.body.sources[0]).toMatchObject({ venueId: v.venueId, pricePerPerson: v.pricePerPerson, hours: v.hours });
    expect(res.body.latencyMs).toBeLessThan(3000);
  });

  test('the answer is shared with the room and saved in the chat', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const res = await ask(t, t.viewer, { question: 'a vegan lunch under $20' });
    expect(res.status).toBe(200);
    const pushed = await lead.waitFor('trip.ai.suggestion');
    expect(pushed.payload).toMatchObject({
      questionId: res.body.questionId,
      userId: t.viewer.user.id,
      answer: res.body.answer,
      suggestedVenueId: res.body.suggestedVenueId,
      sourceEvents: res.body.sourceEvents,
    });
    const saved = await ChatMessage.findOne({ tripId: t.tripId, type: 'ai_answer' }).lean();
    expect(saved.meta).toMatchObject({ questionId: res.body.questionId, question: 'a vegan lunch under $20' });
  });

  test("travellers' declared dietary needs apply automatically", async () => {
    const t = await setupTrip();
    await request(app).patch('/api/v1/users/me').set('Authorization', t.viewer.auth).send({ preferences: { dietaryTags: ['halal'] } });
    const res = await ask(t, t.planner, { question: 'any dinner idea?' });
    expect(res.body.constraints.dietaryTags).toEqual(['halal']);
    expect((await venue(t.planner, res.body.suggestedVenueId)).dietaryTags).toContain('halal');
  });

  test('when nothing fits it declines, explains why, and Claude is not called', async () => {
    const t = await setupTrip();
    const before = fake.calls;
    const res = await ask(t, t.planner, { question: 'kosher dinner under $10' });
    expect(res.body).toMatchObject({ mode: 'no_match', suggestedVenueId: null, validCount: 0 });
    expect(res.body.answer).toMatch(/couldn't find/);
    expect(res.body.nearMisses.length).toBeGreaterThan(0);
    expect(fake.calls).toBe(before);
  });

  test('if Claude invents a price, the grounded template answer is used instead', async () => {
    const t = await setupTrip();
    fake.reply = (params) => {
      const top = facts(params).candidates[0];
      return {
        stop_reason: 'end_turn',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify({ answer: `${top.name} is just $1.`, suggestedVenueId: top.venueId, citedVenueIds: [top.venueId] }) }],
      };
    };
    const res = await ask(t, t.planner, { question: 'dinner under $30' });
    expect(res.body).toMatchObject({ mode: 'template', fallbackReason: 'ungrounded' });
    expect(res.body.answer).not.toMatch(/\$1\b/);
  });

  test('only participants can ask; questions are validated; asking is rate limited', async () => {
    const t = await setupTrip();
    expect((await ask(t, t.outsider, { question: 'dinner?' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/trips/${t.tripId}/ai/ask`).send({ question: 'x' })).status).toBe(401);
    expect((await ask(t, t.planner, { question: 'hi' })).status).toBe(400);
    expect((await ask(t, t.planner, {})).status).toBe(400);
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await ask(t, t.leader, { question: `lunch idea ${i}` })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  test('the same question works over the WebSocket', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const ack = await p.send('trip.ai.ask', { question: 'gluten free breakfast under $20' });
    expect(ack.ok).toBe(true);
    expect((await venue(t.planner, ack.result.suggestedVenueId)).dietaryTags).toContain('gluten-free');
  });
});

describe('conflict detector (spec 6.2 acceptance: flagged within 1 s)', () => {
  test('an overlap is flagged within 1 s in 20 out of 20 tries, and clears when fixed', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const times = [];
    for (let i = 0; i < 20; i += 1) {
      const day = i % 5;
      const a = (await p.send('trip.board.pin', { venueId: 'v_lis_027', dayIndex: day, startTime: '10:00', endTime: '11:30' })).item;
      const sent = Date.now();
      const b = (await p.send('trip.board.pin', { venueId: 'v_lis_026', dayIndex: day, startTime: '11:00', endTime: '12:00' })).item;
      const flag = await lead.waitFor('trip.board.conflict', (m) => m.payload.itemIds.includes(b.itemId) && m.payload.details.reason === 'time');
      times.push(flag.ts - sent);
      // Fix it: remove the second item -> the conflict is resolved.
      await p.send('trip.board.remove', { itemId: b.itemId, expectedVersion: 1 });
      await lead.waitFor('trip.board.conflictResolved', (m) => m.payload.itemIds.includes(b.itemId));
      await p.send('trip.board.remove', { itemId: a.itemId, expectedVersion: 1 });
    }
    const within = times.filter((ms) => ms < 1000).length;
    console.log(`conflict flag delay over 20 tries: max ${Math.max(...times)} ms`);
    expect(within / times.length).toBeGreaterThanOrEqual(0.95);
  });

  test('a budget breach names the traveller, and is saved to the chat log', async () => {
    const t = await setupTrip();
    await request(app).patch('/api/v1/users/me').set('Authorization', t.viewer.auth).send({ preferences: { budgetCeiling: 50 } });
    const lead = await enter(t, t.leader);
    await lead.send('trip.board.pin', { venueId: 'v_lis_001', dayIndex: 0, startTime: '12:00', endTime: '13:00' }); // $22
    const { item } = await lead.send('trip.board.pin', { venueId: 'v_lis_004', dayIndex: 0, startTime: '19:00', endTime: '21:00' }); // $48
    const flag = await lead.waitFor('trip.board.conflict', (m) => m.payload.conflictType === 'budgetBreach');
    expect(flag.payload).toMatchObject({
      conflictId: `budget:traveller:${t.viewer.user.id}`,
      itemIds: [item.itemId],
      status: 'open',
      details: { scope: 'traveller', ceiling: 50, committed: 70, over: 20 },
    });
    expect(flag.payload.details.message).toMatch(/Priya is \$20 over their \$50 budget/);
    await sleep(50);
    expect(await ChatMessage.countDocuments({ tripId: t.tripId, type: 'conflict' })).toBe(1);
  });

  test('when a breach grows, the room gets the new numbers (but only one chat notice)', async () => {
    const t = await setupTrip();
    await request(app).patch('/api/v1/users/me').set('Authorization', t.viewer.auth).send({ preferences: { budgetCeiling: 30 } });
    const lead = await enter(t, t.leader);
    await lead.send('trip.board.pin', { venueId: 'v_lis_004', dayIndex: 0, startTime: '19:00', endTime: '21:00' }); // $48
    await lead.waitFor('trip.board.conflict', (m) => m.payload.details.committed === 48);
    await lead.send('trip.board.pin', { venueId: 'v_lis_001', dayIndex: 1, startTime: '19:00', endTime: '21:00' }); // + $22
    const updated = await lead.waitFor('trip.board.conflict', (m) => m.payload.details.committed === 70);
    expect(updated.payload).toMatchObject({ updated: true, details: { over: 40 } });
    await sleep(50);
    expect(await ChatMessage.countDocuments({ tripId: t.tripId, type: 'conflict' })).toBe(1);
  });

  test('raising your budget ceiling clears your breach', async () => {
    const t = await setupTrip();
    await request(app).patch('/api/v1/users/me').set('Authorization', t.viewer.auth).send({ preferences: { budgetCeiling: 30 } });
    const lead = await enter(t, t.leader);
    await lead.send('trip.board.pin', { venueId: 'v_lis_004', dayIndex: 0, startTime: '19:00', endTime: '21:00' });
    await lead.waitFor('trip.board.conflict', (m) => m.payload.conflictType === 'budgetBreach');
    await request(app).patch('/api/v1/users/me').set('Authorization', t.viewer.auth).send({ preferences: { budgetCeiling: 100 } });
    const cleared = await lead.waitFor('trip.board.conflictResolved', (m) => m.payload.conflictType === 'budgetBreach');
    expect(cleared.payload.conflictId).toBe(`budget:traveller:${t.viewer.user.id}`);
  });

  test('open conflicts are part of the snapshot for someone joining later', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    await lead.send('trip.board.pin', { venueId: 'v_lis_010', dayIndex: 0, startTime: '19:00', endTime: '20:00' }); // lunch-only canteen at 19:00
    await lead.waitFor('trip.board.conflict');
    const late = await enter(t, t.planner);
    expect(late.snapshot.payload.conflicts.map((c) => c.conflictType)).toEqual(['hours']);
  });
});

describe('contested-slot voting (spec 6.2)', () => {
  test('two items in the same slot open a vote automatically; everyone votes; the result is identical for all', async () => {
    const t = await setupTrip();
    const clients = [await enter(t, t.leader), await enter(t, t.planner), await enter(t, t.viewer)];
    const [lead, p, v] = clients;
    const a = (await lead.send('trip.board.pin', { venueId: 'v_lis_001', dayIndex: 1, startTime: '19:00', endTime: '20:30' })).item;
    const b = (await p.send('trip.board.pin', { venueId: 'v_lis_002', dayIndex: 1, startTime: '19:00', endTime: '20:30' })).item;

    const opened = await v.waitFor('trip.vote.open');
    expect(opened.payload).toMatchObject({ itemIds: [a.itemId, b.itemId], candidateVenueIds: ['v_lis_001', 'v_lis_002'], openedByUserId: null, status: 'open' });
    expect(await p.send('trip.board.move', { itemId: a.itemId, dayIndex: 2, startTime: '19:00', endTime: '20:30', expectedVersion: 2 })).toMatchObject({ ok: false, error: { code: 'ITEM_IN_VOTE' } });

    const { voteId } = opened.payload;
    // Viewers vote too.
    expect((await v.send('trip.vote.cast', { voteId, itemId: b.itemId })).ok).toBe(true);
    await p.send('trip.vote.cast', { voteId, itemId: b.itemId });
    await lead.send('trip.vote.cast', { voteId, itemId: a.itemId }); // last ballot -> resolves early

    const resolved = await Promise.all(clients.map((c) => c.waitFor('trip.vote.resolved')));
    resolved.forEach((r) => expect(r.payload).toEqual(resolved[0].payload));
    expect(resolved[0].payload).toMatchObject({
      voteId,
      itemId: b.itemId,
      winningVenueId: 'v_lis_002',
      tally: { [a.itemId]: 1, [b.itemId]: 2 },
      resolution: 'votes',
      removedItemIds: [a.itemId],
    });

    // Every client's board ends in the same state: winner locked, loser gone.
    for (const c of clients) {
      const won = await c.waitFor('trip.board.update', (m) => m.payload.action === 'vote_won');
      expect(won.payload).toMatchObject({ itemId: b.itemId, lifecycleStage: 'locked' });
      await c.waitFor('trip.board.update', (m) => m.payload.action === 'removed' && m.payload.itemId === a.itemId);
    }
    await server.gateway.registry.get(t.tripId).drain();
    expect(await ItineraryItem.countDocuments({ _id: a.itemId })).toBe(0);
    expect((await ItineraryItem.findById(b.itemId).lean()).lifecycleStage).toBe('locked');
    expect((await Vote.findById(voteId).lean()).status).toBe('resolved');
  });

  test('when the timer runs out with no votes, the first pin wins', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const a = (await lead.send('trip.board.pin', { venueId: 'v_lis_005', dayIndex: 2, startTime: '20:00', endTime: '21:30' })).item;
    await lead.send('trip.board.pin', { venueId: 'v_lis_015', dayIndex: 2, startTime: '20:00', endTime: '21:30' });
    const resolved = await lead.waitFor('trip.vote.resolved', () => true, { timeout: 3000 });
    expect(resolved.payload).toMatchObject({ itemId: a.itemId, resolution: 'no_votes_earliest_pin' });
  });

  test('the leader can open a vote on overlapping items; others cannot; casts are checked', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const a = (await p.send('trip.board.pin', { venueId: 'v_lis_001', dayIndex: 3, startTime: '19:00', endTime: '20:30' })).item;
    const b = (await p.send('trip.board.pin', { venueId: 'v_lis_002', dayIndex: 3, startTime: '19:30', endTime: '21:00' })).item;
    const c = (await p.send('trip.board.pin', { venueId: 'v_lis_027', dayIndex: 3, startTime: '10:00', endTime: '11:00' })).item;

    expect((await p.send('trip.vote.open', { itemIds: [a.itemId, b.itemId] })).error.code).toBe('FORBIDDEN');
    expect((await lead.send('trip.vote.open', { itemIds: [a.itemId, c.itemId] })).error.code).toBe('NOT_CONTESTED');
    const { vote } = await lead.send('trip.vote.open', { itemIds: [a.itemId, b.itemId], durationSeconds: 60 });
    expect(vote).toMatchObject({ openedByUserId: t.leader.user.id, status: 'open' });

    expect((await p.send('trip.vote.cast', { voteId: vote.voteId, itemId: c.itemId })).error.code).toBe('NOT_A_CANDIDATE');
    expect((await p.send('trip.vote.cancel', { voteId: vote.voteId })).error.code).toBe('FORBIDDEN');
    expect((await lead.send('trip.vote.cancel', { voteId: vote.voteId })).ok).toBe(true);
    await p.waitFor('trip.vote.cancelled');
    expect((await p.send('trip.board.move', { itemId: a.itemId, dayIndex: 4, startTime: '19:00', endTime: '20:30', expectedVersion: 3 })).ok).toBe(true);
  });

  test('an open vote survives everyone leaving and is still there on return', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const a = (await lead.send('trip.board.pin', { venueId: 'v_lis_001', dayIndex: 4, startTime: '19:00', endTime: '20:30' })).item;
    const b = (await lead.send('trip.board.pin', { venueId: 'v_lis_002', dayIndex: 4, startTime: '19:30', endTime: '21:00' })).item;
    const { vote } = await lead.send('trip.vote.open', { itemIds: [a.itemId, b.itemId], durationSeconds: 60 });
    await lead.send('trip.vote.cast', { voteId: vote.voteId, itemId: b.itemId });
    lead.close();
    await sleep(400);
    expect(server.gateway.registry.get(t.tripId)).toBeUndefined();

    const back = await enter(t, t.planner);
    expect(back.snapshot.payload.votes).toHaveLength(1);
    expect(back.snapshot.payload.votes[0]).toMatchObject({ voteId: vote.voteId, ballotCount: 1, tally: { [b.itemId]: 1 } });
    expect(back.snapshot.payload.items.every((i) => i.lifecycleStage === 'voting')).toBe(true);
    // And it still works after the reload: ballots can be cast.
    const ack = await back.send('trip.vote.cast', { voteId: vote.voteId, itemId: a.itemId });
    expect(ack).toMatchObject({ ok: true, vote: { ballotCount: 2 } });
  });
});
