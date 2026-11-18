import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { RefreshToken } from './refreshToken.model.js';
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

export async function issueRefreshToken(userId, config, family = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ tokenHash: hash(token), userId, family, expiresAt });
  return { token, expiresAt };
}

// Exchanges a refresh token for a new one (rotation). Returns { userId, token, expiresAt }.
export async function rotateRefreshToken(token, config) {
  if (!token) throw unauthorized('Refresh token missing', 'REFRESH_MISSING');

  const record = await RefreshToken.findOne({ tokenHash: hash(token) });
  if (!record) throw unauthorized('Refresh token invalid', 'REFRESH_INVALID');

  if (record.revokedAt) {
    // Reuse of a replaced token: assume theft and log out that whole session.
    await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { revokedAt: new Date() });
    throw unauthorized('Refresh token was already used', 'REFRESH_REUSED');
  }
  if (record.expiresAt <= new Date()) throw unauthorized('Refresh token expired', 'REFRESH_EXPIRED');

  // Atomic claim so two parallel refreshes cannot both succeed.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: record._id, revokedAt: null },
    { revokedAt: new Date() },
  );
  if (!claimed) throw unauthorized('Refresh token was already used', 'REFRESH_REUSED');

  const next = await issueRefreshToken(record.userId, config, record.family);
  return { userId: record.userId, ...next };
}

export async function revokeRefreshFamily(token) {
  if (!token) return;
  const record = await RefreshToken.findOne({ tokenHash: hash(token) });
  if (record) {
    await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { revokedAt: new Date() });
  }
}

export function refreshCookieOptions(config, expiresAt) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  };
}
