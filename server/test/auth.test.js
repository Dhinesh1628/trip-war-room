import request from 'supertest';
import jwt from 'jsonwebtoken';
import { startTestServer, registerUser } from './helpers.js';
import { User } from '../src/auth/user.model.js';
import { RefreshToken } from '../src/auth/refreshToken.model.js';
import { createApp } from '../src/app.js';

let server;
let app;

beforeAll(async () => {
  server = await startTestServer();
  app = server.app;
});

afterAll(async () => {
  await server.stop();
});

const refreshCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('twr_refresh='));

describe('register', () => {
  test('creates an account, returns a short-lived JWT and sets an httpOnly refresh cookie', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: '  Ana@Example.TEST ', password: 'long enough pw', displayName: 'Ana' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ana@example.test', displayName: 'Ana', role: 'user' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.expiresIn).toBeLessThanOrEqual(3600);

    const claims = jwt.decode(res.body.accessToken);
    expect(claims.sub).toBe(res.body.user.id);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);

    const cookie = refreshCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  test('stores a bcrypt hash, never the password', async () => {
    const { user, password } = await registerUser(app);
    const doc = await User.findById(user.id).select('+passwordHash').lean();
    expect(doc.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(doc.passwordHash).not.toContain(password);
  });

  test('rejects a duplicate email with 409', async () => {
    const { user } = await registerUser(app);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: user.email.toUpperCase(), password: 'another password', displayName: 'Copy' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('validates fields and reports each problem', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', displayName: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = res.body.error.details.map((d) => d.path).sort();
    expect(paths).toEqual(['displayName', 'email', 'password']);
  });

  test('cannot self-assign the admin role', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'sneaky@example.test', password: 'long enough pw', displayName: 'S', role: 'admin' });
    // Unknown fields are stripped, so the account is created as a normal user.
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
  });
});

describe('login', () => {
  test('logs in with the right password', async () => {
    const { user, password } = await registerUser(app);
    const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(refreshCookie(res)).toBeTruthy();
  });

  test('wrong password and unknown email give the same answer', async () => {
    const { user } = await registerUser(app);
    const wrong = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'nope nope' });
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'nope nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });
});

describe('access tokens', () => {
  test('/me needs a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  test('/me works with a valid token', async () => {
    const { auth, user } = await registerUser(app);
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  test('an expired token is rejected with TOKEN_EXPIRED so the client knows to refresh', async () => {
    const { user } = await registerUser(app);
    const expired = jwt.sign({ role: 'user' }, server.config.jwtSecret, {
      subject: user.id,
      expiresIn: -10,
      issuer: 'trip-war-room',
      audience: 'twr-api',
    });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  test('a token signed with another key is rejected', async () => {
    const { user } = await registerUser(app);
    const forged = jwt.sign({ role: 'admin' }, 'some-other-secret-key-of-enough-length', {
      subject: user.id,
      issuer: 'trip-war-room',
      audience: 'twr-api',
    });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('a token with the "none" algorithm is rejected', async () => {
    const { user } = await registerUser(app);
    const unsigned = jwt.sign({ role: 'admin', sub: user.id }, '', { algorithm: 'none' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${unsigned}`);
    expect(res.status).toBe(401);
  });

  test('a token for a deleted account stops working', async () => {
    const { auth, user } = await registerUser(app);
    await User.deleteOne({ _id: user.id });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', auth);
    expect(res.status).toBe(401);
  });
});

describe('refresh token flow', () => {
  test('refresh returns a new access token and rotates the cookie', async () => {
    const { agent } = await registerUser(app);
    const first = await agent.post('/api/v1/auth/refresh');
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    const second = await agent.post('/api/v1/auth/refresh');
    expect(second.status).toBe(200);
    expect(refreshCookie(first)).not.toEqual(refreshCookie(second));
  });

  test('refresh without a cookie is rejected', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_MISSING');
  });

  test('reusing an old refresh token revokes the whole session (theft detection)', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'reuse@example.test', password: 'long enough pw', displayName: 'R' });
    const oldCookie = refreshCookie(reg).split(';')[0];

    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie);
    expect(rotated.status).toBe(200);
    const newCookie = refreshCookie(rotated).split(';')[0];

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');

    // The legitimate newer token is now revoked too.
    const after = await request(app).post('/api/v1/auth/refresh').set('Cookie', newCookie);
    expect(after.status).toBe(401);
  });

  test('two refreshes racing with the same token: only one wins', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'race@example.test', password: 'long enough pw', displayName: 'R' });
    const cookie = refreshCookie(reg).split(';')[0];
    const results = await Promise.all([
      request(app).post('/api/v1/auth/refresh').set('Cookie', cookie),
      request(app).post('/api/v1/auth/refresh').set('Cookie', cookie),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test('refresh tokens are stored hashed', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'hashed@example.test', password: 'long enough pw', displayName: 'H' });
    const raw = decodeURIComponent(refreshCookie(reg).split(';')[0].split('=')[1]);
    expect(await RefreshToken.findOne({ tokenHash: raw })).toBeNull();
    expect(await RefreshToken.countDocuments({ userId: reg.body.user.id })).toBe(1);
  });

  test('logout revokes the refresh token', async () => {
    const { agent } = await registerUser(app);
    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('preferences', () => {
  test('a traveller can set dietary tags and a budget ceiling', async () => {
    const { auth } = await registerUser(app);
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', auth)
      .send({ preferences: { dietaryTags: ['vegan', 'vegan', 'gluten-free'], budgetCeiling: 40 } });
    expect(res.status).toBe(200);
    expect(res.body.user.preferences).toEqual({ dietaryTags: ['vegan', 'gluten-free'], budgetCeiling: 40 });
  });

  test('unknown dietary tags are rejected', async () => {
    const { auth } = await registerUser(app);
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', auth)
      .send({ preferences: { dietaryTags: ['vegeterian'] } });
    expect(res.status).toBe(400);
  });

  test('role cannot be changed through the profile endpoint', async () => {
    const { auth } = await registerUser(app);
    const res = await request(app).patch('/api/v1/users/me').set('Authorization', auth).send({ role: 'admin' });
    expect(res.status).toBe(400);
  });
});

describe('rate limiting', () => {
  test('too many login attempts get 429', async () => {
    // A second app on the same database, with a limit of 2 attempts.
    const limited = createApp({ ...server.config, authRateLimit: 2 });
    const attempt = () =>
      request(limited).post('/api/v1/auth/login').send({ email: 'x@example.test', password: 'wrong pass' });
    await attempt();
    await attempt();
    const third = await attempt();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });
});
