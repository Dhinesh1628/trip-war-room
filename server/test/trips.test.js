import request from 'supertest';
import { startTestServer, registerUser, createTrip, joinTrip, LISBON_TRIP } from './helpers.js';
import { generateInviteCode, normalizeInviteCode, INVITE_CODE_PATTERN } from '../src/trips/inviteCode.js';

let server;
let app;

beforeAll(async () => {
  server = await startTestServer({ seed: true });
  app = server.app;
});

afterAll(async () => {
  await server.stop();
});

describe('invite codes', () => {
  test('look like AB-7Q2K and avoid confusable characters', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateInviteCode();
      expect(code).toMatch(INVITE_CODE_PATTERN);
      expect(code).not.toMatch(/[01IOL]/);
    }
  });

  test('are normalised from what people actually type', () => {
    expect(normalizeInviteCode(' ab7q2k ')).toBe('AB-7Q2K');
    expect(normalizeInviteCode('ab-7q2k')).toBe('AB-7Q2K');
    expect(normalizeInviteCode('AB 7Q2K')).toBe('AB-7Q2K');
    expect(normalizeInviteCode('AB-7Q2')).toBeNull();
    expect(normalizeInviteCode('IO-1111')).toBeNull();
    expect(normalizeInviteCode(undefined)).toBeNull();
  });
});

describe('POST /api/v1/trips (spec 7.3.1)', () => {
  test('creates a trip room and returns the spec response shape', async () => {
    const leader = await registerUser(app);
    const res = await request(app).post('/api/v1/trips').set('Authorization', leader.auth).send(LISBON_TRIP);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tripId: expect.any(String),
      inviteCode: expect.stringMatching(INVITE_CODE_PATTERN),
      status: 'drafting',
      leaderUserId: leader.user.id,
      createdAt: expect.any(String),
    });
    expect(res.body.inviteUrl).toBe(`http://localhost:5180/join/${res.body.inviteCode}`);
    expect(res.body.trip).toMatchObject({
      destination: 'Lisbon, Portugal',
      destinationSlug: 'lisbon',
      dayCount: 5,
      totalBudget: 1200,
      myRole: 'leader',
      participantCount: 1,
      settings: { maxParticipants: 8, defaultJoinRole: 'planner' },
    });
    expect(res.body.trip.participants[0]).toMatchObject({ userId: leader.user.id, role: 'leader' });
  });

  test('accepts the destination slug as well as the display name', async () => {
    const leader = await registerUser(app);
    const trip = await createTrip(app, leader, { destination: 'lisbon' });
    expect(trip.trip.destination).toBe('Lisbon, Portugal');
  });

  test.each([
    ['end before start', { startDate: '2026-12-14', endDate: '2026-12-10' }, 'endDate'],
    ['longer than 30 days', { startDate: '2026-12-01', endDate: '2027-01-15' }, 'endDate'],
    ['impossible date', { startDate: '2026-02-30' }, 'startDate'],
    ['negative budget', { totalBudget: -5 }, 'totalBudget'],
    ['budget as a string', { totalBudget: '1200' }, 'totalBudget'],
    ['budget with 3 decimals', { totalBudget: 10.005 }, 'totalBudget'],
    ['room larger than 50', { maxParticipants: 51 }, 'maxParticipants'],
    ['unknown destination', { destination: 'Atlantis' }, 'destination'],
  ])('rejects %s', async (_label, override, path) => {
    const leader = await registerUser(app);
    const res = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', leader.auth)
      .send({ ...LISBON_TRIP, ...override });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path)).toContain(path);
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/api/v1/trips').send(LISBON_TRIP);
    expect(res.status).toBe(401);
  });
});

describe('joining a trip', () => {
  test('join by invite code assigns the default join role', async () => {
    const leader = await registerUser(app);
    const friend = await registerUser(app);
    const { inviteCode } = await createTrip(app, leader, { defaultJoinRole: 'viewer' });

    const res = await joinTrip(app, friend, inviteCode.toLowerCase().replace('-', ''));
    expect(res.status).toBe(201);
    expect(res.body.joined).toBe(true);
    const me = res.body.trip.participants.find((p) => p.userId === friend.user.id);
    expect(me.role).toBe('viewer');
    expect(res.body.trip.myRole).toBe('viewer');
  });

  test('joining twice is harmless', async () => {
    const leader = await registerUser(app);
    const friend = await registerUser(app);
    const { inviteCode } = await createTrip(app, leader);
    await joinTrip(app, friend, inviteCode);
    const again = await joinTrip(app, friend, inviteCode);
    expect(again.status).toBe(200);
    expect(again.body.alreadyMember).toBe(true);
    expect(again.body.trip.participantCount).toBe(2);
  });

  test('a wrong code gives 404', async () => {
    const friend = await registerUser(app);
    expect((await joinTrip(app, friend, 'ZZ-ZZZZ')).status).toBe(404);
    expect((await joinTrip(app, friend, 'garbage')).status).toBe(404);
  });

  test('a full room rejects new travellers with ROOM_FULL', async () => {
    const leader = await registerUser(app);
    const { inviteCode } = await createTrip(app, leader, { maxParticipants: 2 });
    expect((await joinTrip(app, await registerUser(app), inviteCode)).status).toBe(201);
    const res = await joinTrip(app, await registerUser(app), inviteCode);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROOM_FULL');
  });

  test('when 5 people race for the last seat, exactly one gets it', async () => {
    const leader = await registerUser(app);
    const { inviteCode, tripId } = await createTrip(app, leader, { maxParticipants: 2 });
    const racers = await Promise.all(Array.from({ length: 5 }, () => registerUser(app)));

    const results = await Promise.all(racers.map((r) => joinTrip(app, r, inviteCode)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);

    const trip = await request(app).get(`/api/v1/trips/${tripId}`).set('Authorization', leader.auth);
    expect(trip.body.trip.participantCount).toBe(2);
  });

  test('invite preview shows enough to recognise the trip', async () => {
    const leader = await registerUser(app, { displayName: 'Maya' });
    const friend = await registerUser(app);
    const { inviteCode } = await createTrip(app, leader);
    const res = await request(app).get(`/api/v1/trips/invite/${inviteCode}`).set('Authorization', friend.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      destination: 'Lisbon, Portugal',
      leaderName: 'Maya',
      participantCount: 1,
      maxParticipants: 8,
      alreadyJoined: false,
    });
    expect(res.body).not.toHaveProperty('participants');
  });

  test('regenerating the invite code makes the old one stop working', async () => {
    const leader = await registerUser(app);
    const { inviteCode, tripId } = await createTrip(app, leader);
    const regen = await request(app).post(`/api/v1/trips/${tripId}/invite-code`).set('Authorization', leader.auth);
    expect(regen.status).toBe(200);
    expect(regen.body.inviteCode).not.toBe(inviteCode);
    expect((await joinTrip(app, await registerUser(app), inviteCode)).status).toBe(404);
    expect((await joinTrip(app, await registerUser(app), regen.body.inviteCode)).status).toBe(201);
  });
});

describe('listing and settings', () => {
  test('GET /trips lists only my trips, newest first', async () => {
    const me = await registerUser(app);
    const other = await registerUser(app);
    const a = await createTrip(app, me);
    const b = await createTrip(app, me);
    await createTrip(app, other);

    const res = await request(app).get('/api/v1/trips').set('Authorization', me.auth);
    expect(res.status).toBe(200);
    expect(res.body.trips.map((t) => t.tripId)).toEqual([b.tripId, a.tripId]);
  });

  test('capacity cannot be lowered below the current headcount', async () => {
    const leader = await registerUser(app);
    const { tripId, inviteCode } = await createTrip(app, leader);
    await joinTrip(app, await registerUser(app), inviteCode);
    await joinTrip(app, await registerUser(app), inviteCode);
    const res = await request(app)
      .patch(`/api/v1/trips/${tripId}/settings`)
      .set('Authorization', leader.auth)
      .send({ maxParticipants: 2 });
    expect(res.status).toBe(400);
  });

  test('an invalid trip id gives 404, not 500', async () => {
    const me = await registerUser(app);
    expect((await request(app).get('/api/v1/trips/not-an-id').set('Authorization', me.auth)).status).toBe(404);
    expect(
      (await request(app).get('/api/v1/trips/64b7f0f0f0f0f0f0f0f0f0f0').set('Authorization', me.auth)).status,
    ).toBe(404);
  });
});
