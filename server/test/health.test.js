import request from 'supertest';
import { startTestServer } from './helpers.js';
import { loadConfig } from '../src/config/env.js';

let server;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.stop();
});

describe('health checks', () => {
  test('API health reports the database as connected', async () => {
    const res = await request(server.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'connected' });
  });

  test('gateway health reports connected clients', async () => {
    const res = await request(server.app).get('/api/v1/health/gateway');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.connectedClients).toBe('number');
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(server.app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('malformed JSON returns 400, not 500', async () => {
    const res = await request(server.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_JSON');
  });
});

describe('config', () => {
  const secret = 'x'.repeat(32);

  test('refuses to start without required secrets', () => {
    expect(() => loadConfig({})).toThrow(/MONGO_URI, JWT_SECRET/);
  });

  test('refuses a short JWT secret', () => {
    expect(() => loadConfig({ MONGO_URI: 'x', JWT_SECRET: 'short' })).toThrow(/at least 32/);
  });

  test('defaults: port 5080 and access tokens no longer than 1 hour', () => {
    const config = loadConfig({ MONGO_URI: 'x', JWT_SECRET: secret });
    expect(config.port).toBe(5080);
    expect(config.accessTokenTtlSeconds).toBeLessThanOrEqual(3600);
  });
});
