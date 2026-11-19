import request from 'supertest';
import { startTestServer, registerUser, createTrip, joinTrip } from './helpers.js';
import { User } from '../src/auth/user.model.js';
import { atLeast, effectiveTripRole } from '../src/auth/roles.js';
import { readFile } from 'node:fs/promises';
import { DATA_DIR } from '../src/venues/seedData.js';
import { FIXTURE_DIR } from './fixtures.js';

// Server-side enforcement of the four roles (spec 10.1, evidence item 12.2).
// One trip, one person per role, plus an outsider, then every protected
// action is tried by every person.

let server;
let app;
let people;
let tripId;
let lisbon;

beforeAll(async () => {
  server = await startTestServer({ seed: true });
  app = server.app;

  const leader = await registerUser(app, { displayName: 'Leader' });
  const planner = await registerUser(app, { displayName: 'Planner' });
  const viewer = await registerUser(app, { displayName: 'Viewer' });
  const admin = await registerUser(app, { displayName: 'Admin', role: 'admin' });
  const outsider = await registerUser(app, { displayName: 'Outsider' });

  const created = await createTrip(app, leader, { defaultJoinRole: 'planner' });
  tripId = created.tripId;
  await joinTrip(app, planner, created.inviteCode);
  await joinTrip(app, viewer, created.inviteCode);
  await request(app)
    .patch(`/api/v1/trips/${tripId}/participants/${viewer.user.id}`)
    .set('Authorization', leader.auth)
    .send({ role: 'viewer' });

  people = { leader, planner, viewer, admin, outsider };
  lisbon = JSON.parse(await readFile(`${FIXTURE_DIR}/lisbon.json`, 'utf8'));
});

afterAll(async () => {
  await server.stop();
});

describe('role ranking (pure functions shared by REST and WebSocket)', () => {
  test('Viewer < Planner < Leader < Admin', () => {
    expect(atLeast('viewer', 'viewer')).toBe(true);
    expect(atLeast('viewer', 'planner')).toBe(false);
    expect(atLeast('planner', 'leader')).toBe(false);
    expect(atLeast('leader', 'planner')).toBe(true);
    expect(atLeast('admin', 'leader')).toBe(true);
    expect(atLeast(null, 'viewer')).toBe(false);
    expect(atLeast('viewer', 'superuser')).toBe(false);
  });

  test('admins act as admin in every trip; non-members have no role', () => {
    const trip = { participants: [{ userId: 'u1', role: 'planner' }] };
    expect(effectiveTripRole({ id: 'u1', role: 'user' }, trip)).toBe('planner');
    expect(effectiveTripRole({ id: 'u2', role: 'user' }, trip)).toBeNull();
    expect(effectiveTripRole({ id: 'u3', role: 'admin' }, trip)).toBe('admin');
  });
});

// [label, request builder, minimum role]
const ACTIONS = [
  ['view the trip', (r) => r.get(`/api/v1/trips/${tripId}`), 'viewer'],
  [
    'change a participant role',
    (r) => r.patch(`/api/v1/trips/${tripId}/participants/${people.planner.user.id}`).send({ role: 'planner' }),
    'leader',
  ],
  ['change room settings', (r) => r.patch(`/api/v1/trips/${tripId}/settings`).send({ aiVerbosity: 'concise' }), 'leader'],
  ['regenerate the invite code', (r) => r.post(`/api/v1/trips/${tripId}/invite-code`), 'leader'],
  ['list venue datasets (admin)', (r) => r.get('/api/v1/admin/datasets'), 'admin'],
  ['upload a venue dataset (admin)', (r) => r.post('/api/v1/admin/datasets').send(lisbon), 'admin'],
];

const RANK = { outsider: 0, viewer: 1, planner: 2, leader: 3, admin: 4 };
const MIN = { viewer: 1, planner: 2, leader: 3, admin: 4 };

describe('every protected action, tried by every role', () => {
  for (const [label, build, minimum] of ACTIONS) {
    for (const who of ['outsider', 'viewer', 'planner', 'leader', 'admin']) {
      const allowed = RANK[who] >= MIN[minimum];
      test(`${who} ${allowed ? 'CAN' : 'cannot'} ${label}`, async () => {
        const res = await build(request(app)).set('Authorization', people[who].auth);
        if (allowed) {
          expect(res.status).toBeLessThan(300);
        } else {
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
      });
    }
  }

  test('no token at all gets 401 on every protected action', async () => {
    for (const [, build] of ACTIONS) {
      const res = await build(request(app));
      expect(res.status).toBe(401);
    }
  });
});

describe('role details', () => {
  test("the leader's own role cannot be downgraded by the role endpoint", async () => {
    const res = await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${people.leader.user.id}`)
      .set('Authorization', people.leader.auth)
      .send({ role: 'viewer' });
    expect(res.status).toBe(403);
  });

  test('a role can only be set to planner or viewer (not leader/admin)', async () => {
    const res = await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${people.planner.user.id}`)
      .set('Authorization', people.leader.auth)
      .send({ role: 'admin' });
    expect(res.status).toBe(400);
  });

  test('removing admin rights takes effect immediately, even with an unexpired token', async () => {
    const temp = await registerUser(app, { role: 'admin' });
    expect((await request(app).get('/api/v1/admin/datasets').set('Authorization', temp.auth)).status).toBe(200);
    await User.updateOne({ _id: temp.user.id }, { role: 'user' });
    expect((await request(app).get('/api/v1/admin/datasets').set('Authorization', temp.auth)).status).toBe(403);
  });

  test('only leaders and admins see the invite code', async () => {
    for (const who of ['leader', 'admin']) {
      const res = await request(app).get(`/api/v1/trips/${tripId}`).set('Authorization', people[who].auth);
      expect(res.body.trip.inviteCode).toBeTruthy();
    }
    for (const who of ['planner', 'viewer']) {
      const res = await request(app).get(`/api/v1/trips/${tripId}`).set('Authorization', people[who].auth);
      expect(res.body.trip).not.toHaveProperty('inviteCode');
    }
  });

  test('each participant sees their own role in the trip', async () => {
    for (const who of ['leader', 'planner', 'viewer', 'admin']) {
      const res = await request(app).get(`/api/v1/trips/${tripId}`).set('Authorization', people[who].auth);
      expect(res.body.trip.myRole).toBe(who);
    }
  });
});
