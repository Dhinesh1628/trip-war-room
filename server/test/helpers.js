import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { loadConfig } from '../src/config/env.js';
import { buildServer } from '../src/server.js';
import { User } from '../src/auth/user.model.js';
import { seedAllDestinations } from '../src/venues/seedData.js';

export function testConfig(overrides = {}) {
  return loadConfig({
    MONGO_URI: 'mongodb://unused-in-tests',
    JWT_SECRET: 'test-secret-only-used-by-the-automated-test-suite',
    NODE_ENV: 'test',
    BCRYPT_ROUNDS: '4', // fast hashing for tests only
    AUTH_RATE_LIMIT: '10000',
    ...overrides,
  });
}

// Starts a throwaway in-memory MongoDB and a real HTTP + Socket.io server on a
// random free port. Returns everything a test needs plus a stop() function.
// `llm` replaces the Claude client (null = no key, template answers only).
export async function startTestServer({ seed = false, env = {}, llm = null } = {}) {
  const mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  if (seed) await seedAllDestinations();

  const config = { ...testConfig(env), mongoUri: mongo.getUri(), llm };
  const { httpServer, app, gateway } = buildServer(config);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;

  async function stop() {
    await gateway.shutdown();
    await new Promise((resolve) => httpServer.close(resolve));
    await disconnectDb();
    await mongo.stop();
  }

  return { app, url, gateway, config, stop };
}

let counter = 0;

// Registers a fresh user. Returns { token, user, agent, auth } where `auth`
// is the Authorization header value and `agent` keeps the refresh cookie.
export async function registerUser(app, { role, ...overrides } = {}) {
  counter += 1;
  const body = {
    email: `traveller${counter}-${Date.now()}@example.test`,
    password: 'correct horse battery',
    displayName: `Traveller ${counter}`,
    ...overrides,
  };
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/register').send(body);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (role === 'admin') await User.updateOne({ _id: res.body.user.id }, { role: 'admin' });
  return {
    token: res.body.accessToken,
    auth: `Bearer ${res.body.accessToken}`,
    user: res.body.user,
    agent,
    password: body.password,
  };
}

export const LISBON_TRIP = {
  destination: 'Lisbon, Portugal',
  startDate: '2026-12-10',
  endDate: '2026-12-14',
  totalBudget: 1200,
  maxParticipants: 8,
};

export async function createTrip(app, leader, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/trips')
    .set('Authorization', leader.auth)
    .send({ ...LISBON_TRIP, ...overrides });
  if (res.status !== 201) throw new Error(`create trip failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function joinTrip(app, user, inviteCode) {
  return request(app).post('/api/v1/trips/join').set('Authorization', user.auth).send({ inviteCode });
}
