import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from './user.model.js';
import {
  REFRESH_COOKIE,
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshFamily,
  refreshCookieOptions,
} from './tokens.js';
import { requireAuth } from './middleware.js';
import { validate } from '../lib/validate.js';
import { conflict, unauthorized } from '../lib/errors.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
// bcrypt only uses the first 72 bytes of a password, so longer ones are refused.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password is too long (max 72 bytes)');

const registerSchema = z.object({
  email,
  password,
  displayName: z.string().trim().min(1, 'Display name is required').max(60),
});

const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required') });

// A real hash of a random string, so a login for an unknown email takes the
// same time as a wrong password (no account enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 10);

export function authRouter(config) {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
  });

  async function startSession(res, user, status = 200) {
    const { token, expiresAt } = await issueRefreshToken(user._id, config);
    res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(config, expiresAt));
    res.status(status).json({
      accessToken: signAccessToken(user, config),
      expiresIn: config.accessTokenTtlSeconds,
      user: user.toPublic(),
    });
  }

  router.post('/register', limiter, validate(registerSchema), async (req, res) => {
    const { email: addr, password: pw, displayName } = req.valid.body;
    if (await User.exists({ email: addr })) {
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(pw, config.bcryptRounds);
    let user;
    try {
      user = await User.create({ email: addr, displayName, passwordHash });
    } catch (err) {
      if (err.code === 11000) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
    await startSession(res, user, 201);
  });

  router.post('/login', limiter, validate(loginSchema), async (req, res) => {
    const { email: addr, password: pw } = req.valid.body;
    const user = await User.findOne({ email: addr }).select('+passwordHash');
    const ok = await bcrypt.compare(pw, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Email or password is incorrect', 'BAD_CREDENTIALS');
    await startSession(res, user);
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
    const user = await User.findById(rotated.userId);
    if (!user) throw unauthorized('Account no longer exists', 'REFRESH_INVALID');
    res.cookie(REFRESH_COOKIE, rotated.token, refreshCookieOptions(config, rotated.expiresAt));
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

  return router;
}
