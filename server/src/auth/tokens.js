import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { RefreshToken } from './refreshToken.model.js';
import { User } from './user.model.js';
import { unauthorized } from '../lib/errors.js';

const ISSUER = 'trip-war-room';
const AUDIENCE = 'twr-api';

export const REFRESH_COOKIE = 'twr_refresh';

// ---- Access tokens (JWT, short-lived) ------------------------------------

export function signAccessToken(user, config) {
  return jwt.sign({ role: user.role, name: user.displayName }, config.jwtSecret, {
    subject: String(user._id ?? user.id),
    expiresIn: config.accessTokenTtlSeconds,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

// Returns { id, role, name, exp } or throws a 401. Used by both REST and WebSocket.
export function verifyAccessToken(token, config) {
  if (!token) throw unauthorized();
  try {
    const claims = jwt.verify(token, config.jwtSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return { id: claims.sub, role: claims.role, name: claims.name, exp: claims.exp };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
}

// ---- Refresh tokens (opaque, rotated, stored hashed) ---------------------

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export async function issueRefreshToken(userId, config, family = crypto.randomUUID(), persistent = true) {
  const token = crypto.randomBytes(48).toString('base64url');
  const ttlMs = persistent ? config.refreshTokenTtlDays * 24 * 60 * 60 * 1000 : config.shortSessionHours * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  await RefreshToken.create({ tokenHash: hash(token), userId, family, expiresAt, persistent });
  return { token, expiresAt, persistent, family };
}

// Exchanges a refresh token for a new one (rotation). Returns { userId, token, expiresAt }.
// Two database round trips on the happy path: one atomic claim, then the new
// token and the user load in parallel. The slower diagnosis (why a claim
// failed) only runs when something is wrong.
export async function rotateRefreshToken(token, config) {
  if (!token) throw unauthorized('Refresh token missing', 'REFRESH_MISSING');
  const tokenHash = hash(token);
  const now = new Date();

  // Atomic claim: only an unused, unexpired token matches, so two parallel
  // refreshes with the same token cannot both succeed.
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { revokedAt: now },
  );

  if (!claimed) {
    const record = await RefreshToken.findOne({ tokenHash });
    if (!record) throw unauthorized('Refresh token invalid', 'REFRESH_INVALID');
    if (record.revokedAt) {
      // Reuse of a replaced token: assume theft and log out that whole session.
      await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { revokedAt: new Date() });
      throw unauthorized('Refresh token was already used', 'REFRESH_REUSED');
    }
    throw unauthorized('Refresh token expired', 'REFRESH_EXPIRED');
  }

  const [next, user] = await Promise.all([
    issueRefreshToken(claimed.userId, config, claimed.family, claimed.persistent !== false),
    User.findById(claimed.userId),
  ]);
  return { userId: claimed.userId, user, ...next };
}

export async function revokeRefreshFamily(token) {
  if (!token) return;
  const record = await RefreshToken.findOne({ tokenHash: hash(token) });
  if (record) {
    await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { revokedAt: new Date() });
  }
}

// A persistent session gets a dated cookie; otherwise the cookie ends when the browser closes.
export function refreshCookieOptions(config, expiresAt, persistent = true) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/api/v1/auth',
    ...(persistent ? { expires: expiresAt } : {}),
  };
}

// The session (refresh-token family) a cookie belongs to, or null.
export async function familyOf(token) {
  if (!token) return null;
  const record = await RefreshToken.findOne({ tokenHash: hash(token) }).select('family').lean();
  return record?.family ?? null;
}

// Signs the user out everywhere except the given session (or everywhere).
export async function revokeOtherSessions(userId, keepFamily = null) {
  const filter = { userId, revokedAt: null, ...(keepFamily ? { family: { $ne: keepFamily } } : {}) };
  const r = await RefreshToken.updateMany(filter, { revokedAt: new Date() });
  return r.modifiedCount;
}
