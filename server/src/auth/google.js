import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { unauthorized } from '../lib/errors.js';

// Verifies a Google Identity Services ID token (the "credential" the Sign in
// with Google button returns): RS256 signature against Google's published
// keys, issuer, audience (our client id) and expiry. No extra dependency.

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let keys = { byKid: new Map(), until: 0 };

async function publicKey(kid, fetchImpl = fetch) {
  if (Date.now() > keys.until || !keys.byKid.has(kid)) {
    const res = await fetchImpl(CERTS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw unauthorized('Could not check the Google sign-in right now', 'GOOGLE_UNAVAILABLE');
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
    const { keys: list } = await res.json();
    keys = {
      byKid: new Map(list.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])),
      until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000,
    };
  }
  const key = keys.byKid.get(kid);
  if (!key) throw unauthorized('Google sign-in could not be verified', 'GOOGLE_INVALID');
  return key;
}

// Returns { sub, email, emailVerified, name } or throws a 401.
export async function verifyGoogleCredential(credential, clientId, { fetchImpl } = {}) {
  const decoded = jwt.decode(credential, { complete: true });
  if (!decoded?.header?.kid || decoded.header.alg !== 'RS256') throw unauthorized('Google sign-in could not be verified', 'GOOGLE_INVALID');
  const key = await publicKey(decoded.header.kid, fetchImpl);
  let claims;
  try {
    claims = jwt.verify(credential, key, { algorithms: ['RS256'], audience: clientId, issuer: ISSUERS });
  } catch {
    throw unauthorized('Google sign-in could not be verified', 'GOOGLE_INVALID');
  }
  if (!claims.sub) throw unauthorized('Google sign-in could not be verified', 'GOOGLE_INVALID');
  return {
    sub: String(claims.sub),
    email: claims.email ? String(claims.email).toLowerCase() : null,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name ? String(claims.name).slice(0, 60) : null,
  };
}

// Tests replace Google's keys with their own.
export function _setGoogleKeysForTests(map) {
  keys = { byKid: map, until: Date.now() + 3600_000 };
}
