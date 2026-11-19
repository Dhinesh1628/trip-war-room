import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { startTestServer, registerUser, createTrip, joinTrip } from './helpers.js';
import { getOutbox, clearOutbox } from '../src/notify/notify.js';
import { _setGoogleKeysForTests } from '../src/auth/google.js';
import { normalisePhone } from '../src/auth/auth.routes.js';
import { User } from '../src/auth/user.model.js';

// Password reset, email verification, "keep me signed in", changing the
// password, signing out other devices, Google sign-in, phone codes, email
// invites, and the signed-in home page. Emails and texts go to the test inbox.

const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
let server;
let app;

beforeAll(async () => {
  server = await startTestServer({ seed: true, env: { GOOGLE_CLIENT_ID } });
  app = server.app;
});
afterAll(async () => {
  await server.stop();
});
beforeEach(() => clearOutbox());

const lastMail = (to) => getOutbox().find((m) => m.kind === 'email' && m.to === to);
const tokenIn = (text, path) => decodeURIComponent(new RegExp(`${path}\\?token=([^\\s"<]+)`).exec(text)[1]);
const cookieOf = (res) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('twr_refresh='));

describe('sign-in options', () => {
  test('the server says which methods it offers', async () => {
    const res = await request(app).get('/api/v1/auth/providers');
    expect(res.body).toEqual({ google: { clientId: GOOGLE_CLIENT_ID }, phone: true, email: true, testInbox: true });
  });
});

describe('email verification', () => {
  test('sign-up sends a link; it confirms the email once, then stops working', async () => {
    const u = await registerUser(app);
    expect(u.user.emailVerified).toBe(false);
    const mail = lastMail(u.user.email);
    expect(mail.subject).toMatch(/Confirm your email/);
    const token = tokenIn(mail.text, '/verify-email');
    const ok = await request(app).post('/api/v1/auth/email/verify').send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.user.emailVerified).toBe(true);
    const again = await request(app).post('/api/v1/auth/email/verify').send({ token });
    expect(again.status).toBe(400);
  });

  test('resend works for an unverified account and says so for a verified one', async () => {
    const u = await registerUser(app);
    clearOutbox();
    const r = await request(app).post('/api/v1/auth/email/resend').set('Authorization', u.auth);
    expect(r.status).toBe(202);
    expect(lastMail(u.user.email)).toBeTruthy();
    await request(app).post('/api/v1/auth/email/verify').send({ token: tokenIn(lastMail(u.user.email).text, '/verify-email') });
    const done = await request(app).post('/api/v1/auth/email/resend').set('Authorization', u.auth);
    expect(done.body.message).toMatch(/already confirmed/);
  });

  test('a made-up token is refused', async () => {
    const r = await request(app).post('/api/v1/auth/email/verify').send({ token: 'x'.repeat(43) });
    expect(r.status).toBe(400);
  });
});

describe('password reset', () => {
  test('forgot -> email link -> new password; the old one stops working, the link is single-use, other sessions end', async () => {
    const u = await registerUser(app);
    const other = await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: u.password });
    const otherCookie = cookieOf(other).split(';')[0];
    clearOutbox();

    const f = await request(app).post('/api/v1/auth/password/forgot').send({ email: u.user.email });
    expect(f.status).toBe(202);
    const token = tokenIn(lastMail(u.user.email).text, '/reset-password');

    const reset = await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'a brand new password' });
    expect(reset.status).toBe(200);
    expect(reset.body.accessToken).toBeTruthy();
    expect(reset.body.user.emailVerified).toBe(true); // opening the link proves the address

    expect((await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: u.password })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: 'a brand new password' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'yet another password' })).status).toBe(400);
    // The session from the other device was signed out.
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', otherCookie)).status).toBe(401);
  });

  test('an unknown email gets the same answer and no email', async () => {
    const r = await request(app).post('/api/v1/auth/password/forgot').send({ email: 'nobody-here@example.test' });
    expect(r.status).toBe(202);
    expect(getOutbox()).toHaveLength(0);
  });

  test('the new password must be valid', async () => {
    const r = await request(app).post('/api/v1/auth/password/reset').send({ token: 'y'.repeat(43), password: 'short' });
    expect(r.status).toBe(400);
  });
});

describe('keep me signed in', () => {
  test('ticked: a dated cookie; unticked: a cookie that ends with the browser, kept through refreshes', async () => {
    const u = await registerUser(app);
    const keep = await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: u.password, remember: true });
    expect(cookieOf(keep)).toMatch(/Expires=/);
    const brief = await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: u.password, remember: false });
    expect(cookieOf(brief)).not.toMatch(/Expires=/);
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieOf(brief).split(';')[0]);
    expect(refreshed.status).toBe(200);
    expect(cookieOf(refreshed)).not.toMatch(/Expires=/);
  });
});

describe('account security', () => {
  test('changing the password needs the current one and signs out other sessions only', async () => {
    const u = await registerUser(app);
    const other = await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: u.password });
    const otherCookie = cookieOf(other).split(';')[0];
    const here = await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: u.password });
    const hereCookie = cookieOf(here).split(';')[0];
    const auth = `Bearer ${here.body.accessToken}`;

    const wrong = await request(app).post('/api/v1/auth/password/change').set('Authorization', auth).set('Cookie', hereCookie).send({ currentPassword: 'nope nope nope', newPassword: 'changed password 1' });
    expect(wrong.status).toBe(400);
    const ok = await request(app).post('/api/v1/auth/password/change').set('Authorization', auth).set('Cookie', hereCookie).send({ currentPassword: u.password, newPassword: 'changed password 1' });
    expect(ok.status).toBe(200);
    expect(ok.body.signedOutSessions).toBeGreaterThanOrEqual(2); // the sign-up session and "other"
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', otherCookie)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', hereCookie)).status).toBe(200);
  });

  test('"sign out other devices" keeps this one', async () => {
    const u = await registerUser(app);
    const here = await request(app).post('/api/v1/auth/login').send({ email: u.user.email, password: u.password });
    const hereCookie = cookieOf(here).split(';')[0];
    const r = await request(app).post('/api/v1/auth/sessions/revoke-others').set('Authorization', `Bearer ${here.body.accessToken}`).set('Cookie', hereCookie);
    expect(r.body.signedOutSessions).toBe(1);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', hereCookie)).status).toBe(200);
  });
});

describe('Sign in with Google', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  beforeAll(() => _setGoogleKeysForTests(new Map([['kid-1', publicKey]])));
  const credential = (claims, { aud = GOOGLE_CLIENT_ID, kid = 'kid-1', key = privateKey } = {}) =>
    jwt.sign({ email_verified: true, ...claims }, key, { algorithm: 'RS256', keyid: kid, audience: aud, issuer: 'https://accounts.google.com', expiresIn: 300 });

  test('a new Google user gets an account with a verified email and no password', async () => {
    const r = await request(app).post('/api/v1/auth/google').send({ credential: credential({ sub: 'g-1', email: 'Asha@Example.test', name: 'Asha Iyer' }) });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: 'asha@example.test', emailVerified: true, googleLinked: true, passwordSet: false, displayName: 'Asha Iyer' });
    const again = await request(app).post('/api/v1/auth/google').send({ credential: credential({ sub: 'g-1', email: 'asha@example.test' }) });
    expect(again.body.user.id).toBe(r.body.user.id);
  });

  test('a verified Google email links to the existing account with that email', async () => {
    const u = await registerUser(app);
    const r = await request(app).post('/api/v1/auth/google').send({ credential: credential({ sub: 'g-2', email: u.user.email }) });
    expect(r.body.user.id).toBe(u.user.id);
    expect(r.body.user.googleLinked).toBe(true);
  });

  test('an unverified Google email never takes over an existing account', async () => {
    const u = await registerUser(app);
    const r = await request(app).post('/api/v1/auth/google').send({ credential: credential({ sub: 'g-3', email: u.user.email, email_verified: false }) });
    expect(r.status).toBe(409);
  });

  test.each([
    ['another app', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['an unknown key', { kid: 'kid-x' }],
    ['a forged signature', { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }],
  ])('a token for %s is refused', async (_, opts) => {
    const r = await request(app).post('/api/v1/auth/google').send({ credential: credential({ sub: 'g-9', email: 'x@example.test' }, opts) });
    expect(r.status).toBe(401);
  });
});

describe('phone sign-in with a one-time code', () => {
  const codeFor = (phone) => /(\d{6}) is your/.exec(getOutbox().find((m) => m.kind === 'sms' && m.to === phone).text)[1];

  test.each([
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['+44 7700 900123', '+447700900123'],
    ['12345', null],
    ['call me', null],
  ])('%s is read as %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  test('first sign-in asks for a name, then creates the account; the code works once', async () => {
    const phone = '+919800000001';
    expect((await request(app).post('/api/v1/auth/otp/request').send({ phone: '98000 00001' })).status).toBe(202);
    const code = codeFor(phone);
    const ask = await request(app).post('/api/v1/auth/otp/verify').send({ phone, code });
    expect(ask.body).toEqual({ needsName: true, phone });
    const made = await request(app).post('/api/v1/auth/otp/verify').send({ phone, code, displayName: 'Ravi Kumar' });
    expect(made.status).toBe(200);
    expect(made.body.user).toMatchObject({ phone, displayName: 'Ravi Kumar', email: null, passwordSet: false });
    expect((await request(app).post('/api/v1/auth/otp/verify').send({ phone, code })).status).toBe(400);
  });

  test('wrong codes count down, then the code is locked', async () => {
    const phone = '+919800000002';
    await request(app).post('/api/v1/auth/otp/request').send({ phone });
    const code = codeFor(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 1; left -= 1) {
      const r = await request(app).post('/api/v1/auth/otp/verify').send({ phone, code: wrong });
      expect(r.body.error.details[0].message).toContain(`${left} ${left === 1 ? 'try' : 'tries'} left`);
    }
    await request(app).post('/api/v1/auth/otp/verify').send({ phone, code: wrong });
    const locked = await request(app).post('/api/v1/auth/otp/verify').send({ phone, code, displayName: 'X' });
    expect(locked.status).toBe(400);
    expect(locked.body.error.message).toMatch(/Too many wrong codes/);
  });

  test('only the newest code works, and at most 3 codes per number per 10 minutes', async () => {
    const phone = '+919800000003';
    await request(app).post('/api/v1/auth/otp/request').send({ phone });
    const first = codeFor(phone);
    clearOutbox();
    await request(app).post('/api/v1/auth/otp/request').send({ phone });
    const second = codeFor(phone);
    if (first !== second) expect((await request(app).post('/api/v1/auth/otp/verify').send({ phone, code: first, displayName: 'A' })).status).toBe(400);
    await request(app).post('/api/v1/auth/otp/request').send({ phone });
    expect((await request(app).post('/api/v1/auth/otp/request').send({ phone })).status).toBe(429);
  });

  test('a bad number is refused with a clear message', async () => {
    const r = await request(app).post('/api/v1/auth/otp/request').send({ phone: '12' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/mobile number/);
  });
});

describe('email invites and the home page', () => {
  test('the leader emails an invite; it shows on the invitee home page until they join', async () => {
    const leader = await registerUser(app, { displayName: 'Meera' });
    const friend = await registerUser(app);
    const trip = await createTrip(app, leader, { destination: 'jaipur', startDate: '2099-01-10', endDate: '2099-01-12', totalBudget: 40000 });
    clearOutbox();

    const sent = await request(app).post(`/api/v1/trips/${trip.tripId}/invites`).set('Authorization', leader.auth).send({ email: friend.user.email });
    expect(sent.status).toBe(202);
    const mail = lastMail(friend.user.email);
    expect(mail.subject).toBe('Meera invited you to plan a trip to Jaipur, India');
    expect(mail.text).toContain(`/join/${trip.inviteCode}`);

    const home = await request(app).get('/api/v1/users/me/home').set('Authorization', friend.auth);
    expect(home.body.invitations).toEqual([expect.objectContaining({ tripId: trip.tripId, invitedBy: 'Meera', inviteCode: trip.inviteCode })]);

    await joinTrip(app, friend, trip.inviteCode);
    const after = await request(app).get('/api/v1/users/me/home').set('Authorization', friend.auth);
    expect(after.body.invitations).toEqual([]);
    expect(after.body.stats.upcomingTrips).toBe(1);
    expect(after.body.nextTrip).toMatchObject({ tripId: trip.tripId, destination: 'Jaipur, India', currency: 'INR', pinned: 0, totalBudget: 40000 });

    // Only the leader can invite, and not someone already in the trip.
    expect((await request(app).post(`/api/v1/trips/${trip.tripId}/invites`).set('Authorization', friend.auth).send({ email: 'a@example.test' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/trips/${trip.tripId}/invites`).set('Authorization', leader.auth).send({ email: friend.user.email })).status).toBe(409);
  });

  test('home stats count saved places and reviews', async () => {
    const u = await registerUser(app);
    await request(app).put('/api/v1/users/me/saved/v_jai_012').set('Authorization', u.auth);
    await request(app).put('/api/v1/destinations/jaipur/venues/v_jai_012/reviews').set('Authorization', u.auth).send({ rating: 5, text: 'Lovely' });
    const home = await request(app).get('/api/v1/users/me/home').set('Authorization', u.auth);
    expect(home.body.stats).toMatchObject({ upcomingTrips: 0, savedPlaces: 1, reviewsWritten: 1, plannedSpend: 0 });
    expect(home.body.nextTrip).toBeNull();
  });

  test('a phone-only account and an email account can both exist without clashing on email', async () => {
    await User.create({ phone: '+919811111111', displayName: 'P1', passwordSet: false });
    await User.create({ phone: '+919811111112', displayName: 'P2', passwordSet: false });
    expect(await User.countDocuments({ phone: /^\+91981111111/ })).toBe(2);
  });
});
