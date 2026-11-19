import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { startTestServer, registerUser, createTrip, joinTrip } from './helpers.js';
import { joinRoom, sleep } from './socketHelpers.js';
import { TripEvent } from '../src/board/tripEvent.model.js';
import { Interaction } from '../src/recs/interaction.model.js';
import { DATA_DIR } from '../src/venues/seedData.js';
import { FIXTURE_DIR } from './fixtures.js';
import { generateDataset } from '../src/recs/generate.js';
import mongoose from 'mongoose';

// Epic 3 and the budget engine, end to end.

let server;
let app;
const open = [];

beforeAll(async () => {
  server = await startTestServer({ seed: true, env: { PRESENCE_GRACE_MS: '100', FLUSH_INTERVAL_MS: '20', VOTE_SECONDS: '30' } });
  app = server.app;
});

afterEach(() => {
  while (open.length) open.pop().close();
});

afterAll(async () => {
  await server.stop();
});

async function setupTrip(budget = 1200) {
  const leader = await registerUser(app, { displayName: 'Maya' });
  const planner = await registerUser(app, { displayName: 'Sam' });
  const viewer = await registerUser(app, { displayName: 'Priya' });
  const trip = await createTrip(app, leader, { totalBudget: budget });
  await joinTrip(app, planner, trip.inviteCode);
  await joinTrip(app, viewer, trip.inviteCode);
  await request(app)
    .patch(`/api/v1/trips/${trip.tripId}/participants/${viewer.user.id}`)
    .set('Authorization', leader.auth)
    .send({ role: 'viewer' });
  return { tripId: trip.tripId, leader, planner, viewer };
}

async function enter(t, who) {
  const c = await joinRoom(server.url, { token: who.token, tripId: t.tripId });
  open.push(c);
  return c;
}

const get = (t, who, path) => request(app).get(`/api/v1/trips/${t.tripId}${path}`).set('Authorization', who.auth);

describe('who attends and who pays', () => {
  test('attendance and a weighted split change everyone\'s totals exactly', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const { item } = await p.send('trip.board.pin', { venueId: 'v_lis_042', dayIndex: 0, startTime: '15:00', endTime: '16:00' }); // $79 apartments
    // Only Maya and Sam stay; Maya has the bigger room (2:1).
    const res = await p.send('trip.board.setSharing', {
      itemId: item.itemId,
      attendeeIds: [t.leader.user.id, t.planner.user.id],
      split: { type: 'weighted', weights: { [t.leader.user.id]: 2, [t.planner.user.id]: 1 } },
      expectedVersion: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.item).toMatchObject({ positionVersion: 2, split: { type: 'weighted' } });
    // 2 x $79 = 15800 cents split 2:1:
    //   Maya 15800 x 2/3 = 10533 remainder 1;  Sam 15800 x 1/3 = 5266 remainder 2
    //   10533 + 5266 = 15799 -> 1 cent left -> Sam (larger remainder)
    //   Maya $105.33, Sam $52.67
    const budget = await p.waitFor('trip.budget.update', (m) => m.payload.groupCommitted === 158);
    const per = Object.fromEntries(budget.payload.perPerson.map((x) => [x.userId, x.committed]));
    expect(per[t.leader.user.id]).toBe(105.33);
    expect(per[t.planner.user.id]).toBe(52.67);
    expect(per[t.viewer.user.id]).toBe(0);

    const full = await get(t, t.viewer, '/budget');
    expect(full.status).toBe(200);
    expect(full.body.items[0]).toMatchObject({ total: 158, split: 'weighted', attendees: [t.leader.user.id, t.planner.user.id] });
    expect(Object.values(full.body.items[0].shares).reduce((a, b) => a + b, 0)).toBeCloseTo(158, 10);
  });

  test('sharing changes need the current version and valid people; viewers cannot change it', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    const v = await enter(t, t.viewer);
    const { item } = await p.send('trip.board.pin', { venueId: 'v_lis_001', dayIndex: 0, startTime: '19:00', endTime: '20:00' });
    const base = { itemId: item.itemId, split: { type: 'even' } };
    expect((await v.send('trip.board.setSharing', { ...base, expectedVersion: 1 })).error.code).toBe('FORBIDDEN');
    expect((await p.send('trip.board.setSharing', { ...base, expectedVersion: 9 })).error.code).toBe('VERSION_CONFLICT');
    expect((await p.send('trip.board.setSharing', { ...base, attendeeIds: [new mongoose.Types.ObjectId().toString()], expectedVersion: 1 })).error.code).toBe('BAD_SHARING');
    expect((await p.send('trip.board.setSharing', { ...base, split: { type: 'weighted', weights: { [t.leader.user.id]: 0, [t.planner.user.id]: 0, [t.viewer.user.id]: 0 } }, expectedVersion: 1 })).error.code).toBe('BAD_SHARING');
  });
});

describe('budget-split votes', () => {
  async function proposal(t, who) {
    const c = await enter(t, who);
    const { item } = await c.send('trip.board.pin', { venueId: 'v_lis_034', dayIndex: 1, startTime: '17:30', endTime: '19:30' }); // $55 sailing
    const { vote } = await c.send('trip.split.propose', {
      itemId: item.itemId,
      attendeeIds: [t.leader.user.id, t.planner.user.id],
      split: { type: 'even' },
      durationSeconds: 60,
    });
    return { c, item, vote };
  }

  test('a majority yes applies the new split for everyone', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const v = await enter(t, t.viewer);
    const { c: p, item, vote } = await proposal(t, t.planner);
    expect(vote).toMatchObject({ kind: 'split', itemId: item.itemId, status: 'open' });
    await lead.send('trip.split.cast', { voteId: vote.voteId, choice: 'yes' });
    await v.send('trip.split.cast', { voteId: vote.voteId, choice: 'no' });
    await p.send('trip.split.cast', { voteId: vote.voteId, choice: 'yes' }); // everyone voted -> closes
    const resolved = await v.waitFor('trip.split.resolved');
    expect(resolved.payload).toMatchObject({ applied: true, tally: { yes: 2, no: 1 }, resolution: 'majority_yes' });
    const changed = await v.waitFor('trip.board.update', (m) => m.payload.action === 'sharing_changed');
    expect(changed.payload.attendeeIds.sort()).toEqual([t.leader.user.id, t.planner.user.id].sort());
  });

  test('a tie keeps things as they are; a slot-vote cast on a split vote is refused', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const v = await enter(t, t.viewer);
    const { c: p, vote, item } = await proposal(t, t.planner);
    expect((await lead.send('trip.vote.cast', { voteId: vote.voteId, itemId: item.itemId })).error.code).toBe('WRONG_VOTE_KIND');
    await lead.send('trip.split.cast', { voteId: vote.voteId, choice: 'yes' });
    await v.send('trip.split.cast', { voteId: vote.voteId, choice: 'no' });
    await lead.send('trip.vote.cancel', { voteId: vote.voteId });
    await p.waitFor('trip.vote.cancelled');
  });

  test('if the item changes during the vote, the proposal is dropped', async () => {
    const t = await setupTrip();
    const lead = await enter(t, t.leader);
    const v = await enter(t, t.viewer);
    const { c: p, vote, item } = await proposal(t, t.planner);
    await p.send('trip.board.move', { itemId: item.itemId, dayIndex: 2, startTime: '17:30', endTime: '19:30', expectedVersion: 1 });
    await lead.send('trip.split.cast', { voteId: vote.voteId, choice: 'yes' });
    await v.send('trip.split.cast', { voteId: vote.voteId, choice: 'yes' });
    await p.send('trip.split.cast', { voteId: vote.voteId, choice: 'yes' });
    const resolved = await lead.waitFor('trip.split.resolved');
    expect(resolved.payload).toMatchObject({ applied: false, resolution: 'item_changed' });
  });
});

describe('session analytics reconcile exactly with the event log (spec 6.3)', () => {
  test('a manually verified session', async () => {
    const t = await setupTrip(1000);
    const lead = await enter(t, t.leader);
    const p = await enter(t, t.planner);
    const v = await enter(t, t.viewer); // peak: 3 online

    const A = (await lead.send('trip.board.pin', { venueId: 'v_lis_001', dayIndex: 0, startTime: '19:00', endTime: '20:30' })).item; // $22
    const B = (await p.send('trip.board.pin', { venueId: 'v_lis_027', dayIndex: 0, startTime: '10:00', endTime: '11:30' })).item; // $17
    const C = (await p.send('trip.board.pin', { venueId: 'v_lis_026', dayIndex: 0, startTime: '11:00', endTime: '12:00' })).item; // $4, overlaps B
    await lead.waitFor('trip.board.conflict', (m) => m.payload.details.reason === 'time');
    await p.send('trip.board.move', { itemId: C.itemId, dayIndex: 0, startTime: '12:30', endTime: '13:30', expectedVersion: 1 }); // fixes it
    await lead.waitFor('trip.board.conflictResolved');
    // Dinner A: only Maya and Sam.
    await lead.send('trip.board.setSharing', {
      itemId: A.itemId,
      attendeeIds: [t.leader.user.id, t.planner.user.id],
      split: { type: 'even' },
      expectedVersion: 1,
    });
    // Castle B: everyone, weighted 2:1:1 by a split vote.
    const { vote } = await p.send('trip.split.propose', {
      itemId: B.itemId,
      split: { type: 'weighted', weights: { [t.leader.user.id]: 2, [t.planner.user.id]: 1, [t.viewer.user.id]: 1 } },
      durationSeconds: 60,
    });
    for (const c of [lead, p, v]) await c.send('trip.split.cast', { voteId: vote.voteId, choice: 'yes' });
    await lead.waitFor('trip.split.resolved');
    await p.send('trip.ai.ask', { question: 'vegetarian dinner under $25' });
    await v.send('trip.ai.ask', { question: 'a museum on day 2' });
    await v.send('trip.chat.send', { body: 'Looks great!' });
    await lead.send('trip.board.lock', { itemId: A.itemId });

    // Hand-computed expectations:
    //   A  2 x $22.00 = $44.00 -> Maya 22.00, Sam 22.00
    //   B  3 x $17.00 = $51.00 by 2:1:1 -> Maya 25.50, Sam 12.75, Priya 12.75
    //   C  3 x  $4.00 = $12.00 -> 4.00 each
    //   Maya 51.50, Sam 38.75, Priya 16.75; group 107.00 = 44 + 51 + 12
    const res = await get(t, t.viewer, '/analytics');
    expect(res.status).toBe(200);
    const a = res.body;
    expect(a.reconciliation).toEqual({ reconciled: true, differences: [] });
    expect(a.peakConcurrentPlanners).toBe(3);
    expect(a.board).toEqual({ pinned: 3, moved: 1, removed: 0, locked: 1, finalItemCount: 3 });
    expect(a.concierge.questions).toBe(2);
    expect(a.conflicts).toMatchObject({ flagged: 1, resolved: 1, stillOpen: 0, byType: { overlap: 1 } });
    expect(a.votes).toMatchObject({ opened: 1, resolved: 1, ballots: 3, byKind: { split: 1 } });
    expect(a.chatMessages).toBe(1);
    expect(a.planning.durationMinutes).toBeGreaterThanOrEqual(0);
    const per = Object.fromEntries(a.finalBudget.perPerson.map((x) => [x.displayName, x.total]));
    expect(per).toEqual({ Maya: 51.5, Sam: 38.75, Priya: 16.75 });
    expect(a.finalBudget).toMatchObject({ groupTotal: 107, remaining: 893, totalBudget: 1000 });

    // The live budget endpoint gives the same numbers.
    const b = await get(t, t.leader, '/budget');
    expect(Object.fromEntries(b.body.perPerson.map((x) => [x.displayName, x.committed]))).toEqual(per);

    // And every number comes from rows that are really in the log.
    const rows = await TripEvent.find({ tripId: t.tripId }).lean();
    expect(rows.filter((r) => r.type === 'item_pinned')).toHaveLength(3);
    expect(rows.filter((r) => r.type === 'ai_asked')).toHaveLength(2);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
  });

  test('analytics are participant-only', async () => {
    const t = await setupTrip();
    const outsider = await registerUser(app);
    expect((await get(t, outsider, '/analytics')).status).toBe(403);
  });
});

describe('recommendations and the dashboard', () => {
  beforeAll(async () => {
    // Load the generated history, as `npm run generate:interactions` does.
    const venues = JSON.parse(await readFile(`${FIXTURE_DIR}/lisbon.json`, 'utf8')).venues;
    const { train } = generateDataset(venues, { seed: 2026 });
    const ids = new Map();
    const id = (name) => (ids.has(name) ? ids.get(name) : ids.set(name, new mongoose.Types.ObjectId()).get(name));
    await Interaction.insertMany(
      train.map((r) => ({ ...r, userId: id(r.userId), destination: 'lisbon', coTraveledWith: r.coTraveledWith.map(id) })),
    );
  });

  test('"Recommended for your group" ranks venues, skips pinned ones, and respects dietary needs', async () => {
    const t = await setupTrip();
    await request(app).patch('/api/v1/users/me').set('Authorization', t.viewer.auth).send({ preferences: { dietaryTags: ['vegan'] } });
    const p = await enter(t, t.planner);
    for (const venueId of ['v_lis_002', 'v_lis_015', 'v_lis_011']) {
      await p.send('trip.board.pin', { venueId, dayIndex: 1, startTime: `1${venueId.slice(-1)}:00`, endTime: `1${venueId.slice(-1)}:30` });
    }
    await sleep(80);
    const res = await get(t, t.leader, '/recommendations');
    expect(res.status).toBe(200);
    expect(res.body.recommendations).toHaveLength(5);
    expect(res.body.groupDietaryTags).toEqual(['vegan']);
    const ids = res.body.recommendations.map((r) => r.venueId);
    for (const pinned of ['v_lis_002', 'v_lis_015', 'v_lis_011']) expect(ids).not.toContain(pinned);
    for (const r of res.body.recommendations.filter((x) => ['breakfast', 'lunch', 'dinner', 'cafe', 'bar'].includes(x.category))) {
      expect(r.dietaryTags).toContain('vegan');
    }
    expect(res.body.model).toMatchObject({ type: 'hybrid content + collaborative', alpha: 0.5 });
    expect(res.body.model.interactions).toBeGreaterThan(1000);
  });

  test('a new like updates the rail without any retraining step', async () => {
    const me = await registerUser(app);
    await createTrip(app, me);
    const before = await request(app).get('/api/v1/users/me/dashboard').set('Authorization', me.auth);
    expect(before.body.recommendations[0].why).toBe('popular with visitors'); // cold start
    for (const venueId of ['v_lis_028', 'v_lis_030', 'v_lis_036']) {
      const r = await request(app).post(`/api/v1/destinations/lisbon/venues/${venueId}/feedback`).set('Authorization', me.auth).send({ liked: true });
      expect(r.status).toBe(201);
    }
    const after = await request(app).get('/api/v1/users/me/dashboard').set('Authorization', me.auth);
    expect(after.body.recommendations.map((r) => r.venueId)).not.toEqual(before.body.recommendations.map((r) => r.venueId));
    expect(after.body.preferenceProfile.fromHistory.favouriteCategories[0]).toEqual({ name: 'museum', count: 3 });
  });

  test('the dashboard shows trips led and joined, live rooms, and a profile from history', async () => {
    const t = await setupTrip();
    const p = await enter(t, t.planner);
    await p.send('trip.board.pin', { venueId: 'v_lis_002', dayIndex: 0, startTime: '19:00', endTime: '20:00' }); // $18 vegan dinner
    await p.send('trip.board.pin', { venueId: 'v_lis_020', dayIndex: 1, startTime: '09:00', endTime: '10:00' }); // $9 cafe
    await sleep(80);
    const res = await request(app).get('/api/v1/users/me/dashboard').set('Authorization', t.planner.auth);
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.trips.joined.map((x) => x.tripId)).toContain(t.tripId);
    expect(d.trips.led).toEqual([]);
    expect(d.activeRooms.map((x) => x.tripId)).toContain(t.tripId);
    expect(d.preferenceProfile.fromHistory).toMatchObject({ signals: 2, priceRange: { min: 9, median: 13.5, max: 18, currency: 'USD' } });
    expect(d.preferenceProfile.fromHistory.dietaryTagsOfLikedPlaces.map((x) => x.name)).toContain('vegan');
    expect(d.recommendations).toHaveLength(5);
  });

  test('feedback needs a real venue and a boolean', async () => {
    const me = await registerUser(app);
    const post = (id, body) => request(app).post(`/api/v1/destinations/lisbon/venues/${id}/feedback`).set('Authorization', me.auth).send(body);
    expect((await post('v_nope', { liked: true })).status).toBe(404);
    expect((await post('v_lis_001', { liked: 'yes' })).status).toBe(400);
  });
});

describe('saved places (the heart button)', () => {
  test('save, list newest first with city and currency, ignore duplicates, unsave; unknown venues are 404', async () => {
    const { auth } = await registerUser(app);
    const put = (id) => request(app).put(`/api/v1/users/me/saved/${id}`).set('Authorization', auth);
    expect((await put('v_jai_012')).status).toBe(200);
    expect((await put('v_goa_010')).status).toBe(200);
    expect((await put('v_jai_012')).body.savedVenueIds).toEqual(['v_jai_012', 'v_goa_010']);
    expect((await put('v_nope_001')).status).toBe(404);

    const list = await request(app).get('/api/v1/users/me/saved').set('Authorization', auth);
    expect(list.body.saved.map((v) => v.venueId)).toEqual(['v_jai_012', 'v_goa_010']);
    expect(list.body.saved[0]).toMatchObject({ name: 'Hawa Mahal', destinationName: 'Jaipur, India', currency: 'INR', pricePerPerson: 50 });
    expect(list.body.saved[0].image.url).toMatch(/^\/photos\//);

    const del = await request(app).delete('/api/v1/users/me/saved/v_jai_012').set('Authorization', auth);
    expect(del.body.savedVenueIds).toEqual(['v_goa_010']);
    expect((await request(app).get('/api/v1/users/me/saved')).status).toBe(401);
  });
});
