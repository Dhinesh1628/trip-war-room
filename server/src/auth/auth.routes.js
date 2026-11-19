import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from './user.model.js';
import { LinkToken, PhoneCode } from './oneTime.model.js';
import {
  REFRESH_COOKIE,
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshFamily,
  refreshCookieOptions,
  familyOf,
  revokeOtherSessions,
} from './tokens.js';
import { verifyGoogleCredential } from './google.js';
import { requireAuth } from './middleware.js';
import { validate } from '../lib/validate.js';
import { HttpError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { sendEmail, sendSms, channels, NotConfiguredError } from '../notify/notify.js';
import { log } from '../lib/logger.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
// bcrypt only uses the first 72 bytes of a password, so longer ones are refused.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password is too long (max 72 bytes)');
const remember = z.boolean().optional().default(true);
const displayName = z.string().trim().min(1, 'Display name is required').max(60);

// Indian numbers may be typed without +91; anything else needs the country code.
export function normalisePhone(input) {
  const digits = String(input ?? '').replace(/[\s()-]/g, '');
  const e164 = /^\d{10}$/.test(digits) ? `+91${digits}` : /^0\d{10}$/.test(digits) ? `+91${digits.slice(1)}` : digits;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}
const phone = z.string().transform((s, ctx) => {
  const p = normalisePhone(s);
  if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a mobile number, like 98765 43210 or +91 98765 43210' });
  return p;
});

const registerSchema = z.object({ email, password, displayName, remember });
const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required'), remember });
const forgotSchema = z.object({ email });
const resetSchema = z.object({ token: z.string().min(20).max(200), password, remember });
const verifySchema = z.object({ token: z.string().min(20).max(200) });
const changeSchema = z.object({ currentPassword: z.string().max(200).optional(), newPassword: password });
const googleSchema = z.object({ credential: z.string().min(20).max(4096), remember });
const otpRequestSchema = z.object({ phone });
const otpVerifySchema = z.object({ phone, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), displayName: displayName.optional(), remember });

// A real hash of a random string, so a login for an unknown email takes the
// same time as a wrong password (no account enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 10);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const RESET_TTL_MIN = 30;
const VERIFY_TTL_HOURS = 48;
const CODE_TTL_MIN = 5;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_PHONE_PER_10_MIN = 3;

export function authRouter(config) {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
  });

  async function startSession(res, user, { status = 200, persistent = true } = {}) {
    const { token, expiresAt } = await issueRefreshToken(user._id, config, undefined, persistent);
    res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(config, expiresAt, persistent));
    res.status(status).json({
      accessToken: signAccessToken(user, config),
      expiresIn: config.accessTokenTtlSeconds,
      user: user.toPublic(),
    });
  }

  const link = (path, token) => `${config.clientOrigin}${path}?token=${encodeURIComponent(token)}`;

  async function newLinkToken(user, purpose, ttlMs) {
    const token = crypto.randomBytes(32).toString('base64url');
    await LinkToken.create({ tokenHash: sha(token), userId: user._id, purpose, email: user.email, expiresAt: new Date(Date.now() + ttlMs) });
    return token;
  }

  async function sendVerification(user) {
    if (!user.email || user.emailVerified) return;
    const token = await newLinkToken(user, 'verify', VERIFY_TTL_HOURS * 3600_000);
    const url = link('/verify-email', token);
    await sendEmail(config, {
      to: user.email,
      subject: 'Confirm your email for Trip War Room',
      text: `Hi ${user.displayName},\n\nConfirm your email address: ${url}\n\nThe link works for ${VERIFY_TTL_HOURS} hours. If you didn't create an account, you can ignore this email.`,
      html: `<p>Hi ${escapeHtml(user.displayName)},</p><p><a href="${url}">Confirm your email address</a></p><p>The link works for ${VERIFY_TTL_HOURS} hours. If you didn't create an account, you can ignore this email.</p>`,
    });
  }

  // Which sign-in methods this server offers (the client shows only those).
  router.get('/providers', (req, res) => {
    const c = channels(config);
    res.json({ google: config.googleClientId ? { clientId: config.googleClientId } : null, phone: c.sms, email: c.email, testInbox: c.outbox });
  });

  router.post('/register', limiter, validate(registerSchema), async (req, res) => {
    const { email: addr, password: pw, displayName: name, remember: keep } = req.valid.body;
    if (await User.exists({ email: addr })) {
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(pw, config.bcryptRounds);
    let user;
    try {
      user = await User.create({ email: addr, displayName: name, passwordHash, passwordSet: true });
    } catch (err) {
      if (err.code === 11000) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
    // A failed email must not fail the sign-up; they can resend later.
    sendVerification(user).catch((err) => log.warn('verify.email.failed', { error: err.message }));
    await startSession(res, user, { status: 201, persistent: keep });
  });

  router.post('/login', limiter, validate(loginSchema), async (req, res) => {
    const { email: addr, password: pw, remember: keep } = req.valid.body;
    const user = await User.findOne({ email: addr }).select('+passwordHash');
    const ok = await bcrypt.compare(pw, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !ok) throw unauthorized('Email or password is incorrect', 'BAD_CREDENTIALS');
    await startSession(res, user, { persistent: keep });
  });

  // Uses the httpOnly refresh cookie; returns a fresh access token and rotates the cookie.
  router.post('/refresh', async (req, res) => {
    let rotated;
    try {
      rotated = await rotateRefreshToken(req.cookies?.[REFRESH_COOKIE], config);
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
      throw err;
    }
    const { user } = rotated;
    if (!user) throw unauthorized('Account no longer exists', 'REFRESH_INVALID');
    res.cookie(REFRESH_COOKIE, rotated.token, refreshCookieOptions(config, rotated.expiresAt, rotated.persistent));
    res.json({
      accessToken: signAccessToken(user, config),
      expiresIn: config.accessTokenTtlSeconds,
      user: user.toPublic(),
    });
  });

  router.post('/logout', async (req, res) => {
    await revokeRefreshFamily(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    res.status(204).end();
  });

  router.get('/me', requireAuth(config), async (req, res) => {
    const user = await User.findById(req.user.id);
    res.json({ user: user.toPublic() });
  });

  // ---- password reset ----------------------------------------------------
  // Always answers the same way, so it can't be used to find out who has an account.
  router.post('/password/forgot', limiter, validate(forgotSchema), async (req, res) => {
    if (!channels(config).email) throw new HttpError(503, 'EMAIL_UNAVAILABLE', 'Password reset by email is not set up on this server yet');
    const user = await User.findOne({ email: req.valid.body.email });
    if (user) {
      const token = await newLinkToken(user, 'reset', RESET_TTL_MIN * 60_000);
      const url = link('/reset-password', token);
      try {
        await sendEmail(config, {
          to: user.email,
          subject: 'Reset your Trip War Room password',
          text: `Hi ${user.displayName},\n\nSet a new password: ${url}\n\nThe link works once, for ${RESET_TTL_MIN} minutes. If you didn't ask for this, ignore this email; your password stays the same.`,
          html: `<p>Hi ${escapeHtml(user.displayName)},</p><p><a href="${url}">Set a new password</a></p><p>The link works once, for ${RESET_TTL_MIN} minutes. If you didn't ask for this, ignore this email; your password stays the same.</p>`,
        });
      } catch (err) {
        log.error('reset.email.failed', { error: err.message });
      }
    }
    res.status(202).json({ message: 'If an account uses that email, a reset link is on its way.' });
  });

  async function useLinkToken(token, purpose) {
    const now = new Date();
    const record = await LinkToken.findOneAndUpdate(
      { tokenHash: sha(token), purpose, usedAt: null, expiresAt: { $gt: now } },
      { usedAt: now },
    );
    if (!record) throw badRequest(purpose === 'reset' ? 'This reset link has expired or was already used. Ask for a new one.' : 'This link has expired or was already used. Send a new one from your account page.');
    return record;
  }

  router.post('/password/reset', limiter, validate(resetSchema), async (req, res) => {
    const record = await useLinkToken(req.valid.body.token, 'reset');
    const user = await User.findById(record.userId);
    if (!user) throw badRequest('This reset link has expired or was already used. Ask for a new one.');
    user.passwordHash = await bcrypt.hash(req.valid.body.password, config.bcryptRounds);
    user.passwordSet = true;
    // Opening the link proves they own the address.
    if (user.email && user.email === record.email) user.emailVerified = true;
    await user.save();
    await LinkToken.updateMany({ userId: user._id, purpose: 'reset', usedAt: null }, { usedAt: new Date() });
    await revokeOtherSessions(user._id); // sign out everywhere else
    await startSession(res, user, { persistent: req.valid.body.remember });
  });

  // ---- email verification --------------------------------------------------
  router.post('/email/verify', limiter, validate(verifySchema), async (req, res) => {
    const record = await useLinkToken(req.valid.body.token, 'verify');
    const user = await User.findById(record.userId);
    if (!user || user.email !== record.email) throw badRequest('This link has expired or was already used. Send a new one from your account page.');
    user.emailVerified = true;
    await user.save();
    res.json({ user: user.toPublic() });
  });

  router.post('/email/resend', requireAuth(config), limiter, async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user.email) throw badRequest('This account has no email address');
    if (user.emailVerified) return res.json({ message: 'Your email is already confirmed.' });
    try {
      await sendVerification(user);
    } catch (err) {
      if (err instanceof NotConfiguredError) throw new HttpError(503, 'EMAIL_UNAVAILABLE', err.message);
      throw err;
    }
    res.status(202).json({ message: `We sent a new link to ${user.email}.` });
  });

  // ---- account security ----------------------------------------------------
  router.post('/password/change', requireAuth(config), limiter, validate(changeSchema), async (req, res) => {
    const user = await User.findById(req.user.id).select('+passwordHash');
    if (user.passwordHash) {
      const ok = await bcrypt.compare(req.valid.body.currentPassword ?? '', user.passwordHash);
      if (!ok) throw badRequest('Your current password is incorrect', [{ path: 'currentPassword', message: 'Your current password is incorrect' }]);
    }
    user.passwordHash = await bcrypt.hash(req.valid.body.newPassword, config.bcryptRounds);
    user.passwordSet = true;
    await user.save();
    const keep = await familyOf(req.cookies?.[REFRESH_COOKIE]);
    const signedOut = await revokeOtherSessions(user._id, keep);
    res.json({ user: user.toPublic(), signedOutSessions: signedOut });
  });

  router.post('/sessions/revoke-others', requireAuth(config), async (req, res) => {
    const keep = await familyOf(req.cookies?.[REFRESH_COOKIE]);
    const signedOut = await revokeOtherSessions(req.user.id, keep);
    res.json({ signedOutSessions: signedOut });
  });

  // ---- Sign in with Google ---------------------------------------------------
  router.post('/google', limiter, validate(googleSchema), async (req, res) => {
    if (!config.googleClientId) throw new HttpError(503, 'GOOGLE_UNAVAILABLE', 'Sign in with Google is not set up on this server yet');
    const g = await verifyGoogleCredential(req.valid.body.credential, config.googleClientId, { fetchImpl: config.fetchImpl });
    let user = await User.findOne({ googleSub: g.sub });
    if (!user && g.email && g.emailVerified) {
      // Same verified address as an existing account: link them.
      user = await User.findOne({ email: g.email });
      if (user) {
        user.googleSub = g.sub;
        user.emailVerified = true;
        await user.save();
      }
    }
    if (!user) {
      if (g.email && !g.emailVerified && (await User.exists({ email: g.email }))) {
        throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Sign in with your password.');
      }
      user = await User.create({
        googleSub: g.sub,
        email: g.email ?? undefined,
        emailVerified: g.emailVerified,
        displayName: g.name || (g.email ? g.email.split('@')[0] : 'Traveller'),
        passwordSet: false,
      });
    }
    await startSession(res, user, { persistent: req.valid.body.remember });
  });

  // ---- phone sign-in with a one-time code ----------------------------------------
  router.post('/otp/request', limiter, validate(otpRequestSchema), async (req, res) => {
    if (!channels(config).sms) throw new HttpError(503, 'SMS_UNAVAILABLE', 'Phone sign-in is not set up on this server yet');
    const { phone: to } = req.valid.body;
    const recent = await PhoneCode.countDocuments({ phone: to, createdAt: { $gt: new Date(Date.now() - 10 * 60_000) } });
    if (recent >= CODES_PER_PHONE_PER_10_MIN) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many codes for this number. Try again in 10 minutes.');
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await PhoneCode.updateMany({ phone: to, usedAt: null }, { usedAt: new Date() }); // only the newest code works
    await PhoneCode.create({ phone: to, codeHash: sha(`${to}:${code}:${config.jwtSecret}`), expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000) });
    try {
      await sendSms(config, { to, body: `${code} is your Trip War Room sign-in code. It expires in ${CODE_TTL_MIN} minutes. Don't share it.` });
    } catch (err) {
      if (err instanceof NotConfiguredError) throw new HttpError(503, 'SMS_UNAVAILABLE', err.message);
      throw new HttpError(502, 'SMS_FAILED', "We couldn't send the code. Check the number and try again.");
    }
    res.status(202).json({ phone: to, expiresInSeconds: CODE_TTL_MIN * 60 });
  });

  router.post('/otp/verify', limiter, validate(otpVerifySchema), async (req, res) => {
    const { phone: to, code, displayName: name, remember: keep } = req.valid.body;
    const record = await PhoneCode.findOne({ phone: to, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!record) throw badRequest('This code has expired. Ask for a new one.', [{ path: 'code', message: 'This code has expired. Ask for a new one.' }]);
    if (record.attempts >= CODE_MAX_ATTEMPTS) {
      throw badRequest('Too many wrong codes. Ask for a new one.', [{ path: 'code', message: 'Too many wrong codes. Ask for a new one.' }]);
    }
    const expected = Buffer.from(record.codeHash, 'hex');
    const given = Buffer.from(sha(`${to}:${code}:${config.jwtSecret}`), 'hex');
    if (!crypto.timingSafeEqual(expected, given)) {
      record.attempts += 1;
      await record.save();
      const left = CODE_MAX_ATTEMPTS - record.attempts;
      throw badRequest('That code is not right', [{ path: 'code', message: left > 0 ? `That code is not right (${left} ${left === 1 ? 'try' : 'tries'} left)` : 'Too many wrong codes. Ask for a new one.' }]);
    }
    let user = await User.findOne({ phone: to });
    if (!user) {
      // First sign-in with this number creates the account; it needs a name.
      if (!name) return res.status(200).json({ needsName: true, phone: to });
      user = await User.create({ phone: to, displayName: name, passwordSet: false });
    }
    record.usedAt = new Date();
    await record.save();
    await startSession(res, user, { persistent: keep });
  });

  return router;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
