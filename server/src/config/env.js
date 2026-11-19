import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../client/dist');

function resolveClientDist(env) {
  if (env.CLIENT_DIST) return path.resolve(env.CLIENT_DIST);
  if (env.NODE_ENV === 'production' && fs.existsSync(path.join(DEFAULT_DIST, 'index.html'))) return DEFAULT_DIST;
  return null;
}

// Reads settings from environment variables. Secrets are never hard-coded:
// the server refuses to start without them (tests pass their own values).
export function loadConfig(env = process.env) {
  const required = ['MONGO_URI', 'JWT_SECRET'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  if (Number(env.ACCESS_TOKEN_TTL_SECONDS) > 3600) {
    throw new Error('ACCESS_TOKEN_TTL_SECONDS cannot exceed 3600 (spec: tokens live at most 1 hour)');
  }

  const nodeEnv = env.NODE_ENV || 'development';
  return {
    port: Number(env.PORT) || 5080,
    mongoUri: env.MONGO_URI,
    jwtSecret: env.JWT_SECRET,
    // Public address of the site (used in invite links and CORS). Render sets
    // RENDER_EXTERNAL_URL automatically, so nothing is needed there.
    clientOrigin: env.CLIENT_ORIGIN || env.RENDER_EXTERNAL_URL || 'http://localhost:5180',
    // Folder with the built client, served by this process (production).
    // Defaults to ../client/dist when NODE_ENV=production and it exists.
    clientDist: resolveClientDist(env),
    nodeEnv,
    // Access tokens must be short-lived (spec 10.1: <= 1 hour).
    accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS) || 15 * 60,
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS) || 7,
    bcryptRounds: Number(env.BCRYPT_ROUNDS) || 10,
    // Max login/register attempts per IP per 15 minutes.
    authRateLimit: Number(env.AUTH_RATE_LIMIT) || 20,
    // Invite previews and joins per account per 15 minutes (brute-force guard).
    inviteRateLimit: Number(env.INVITE_RATE_LIMIT) || 30,
    secureCookies: nodeEnv === 'production',
    // A "don't keep me signed in" session lasts this long (refresh cookie without an expiry).
    shortSessionHours: Number(env.SHORT_SESSION_HOURS) || 24,
    // Email (Resend) and SMS (Twilio). Without them, outside production,
    // messages go to a test inbox at GET /api/v1/dev/outbox.
    resendApiKey: env.RESEND_API_KEY || null,
    emailFrom: env.EMAIL_FROM || 'Trip War Room <onboarding@resend.dev>',
    twilio: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM
      ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM }
      : null,
    devOutbox: nodeEnv !== 'production',
    // Sign in with Google: the OAuth client id from Google Cloud (public, not a secret).
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    // Set TRUST_PROXY=1 behind a hosting proxy (e.g. Render) so rate limiting sees real IPs.
    trustProxy: env.TRUST_PROXY === '1',
    // Real-time gateway tuning.
    // How long a traveller can be disconnected before others see them leave
    // (a quick reconnect inside this window is invisible to the room).
    presenceGraceMs: env.PRESENCE_GRACE_MS !== undefined ? Number(env.PRESENCE_GRACE_MS) : 5000,
    // Moves are saved in batches at most this often (pins, removes, locks are saved at once).
    flushIntervalMs: env.FLUSH_INTERVAL_MS !== undefined ? Number(env.FLUSH_INTERVAL_MS) : 250,
    chatHistoryLimit: Number(env.CHAT_HISTORY_LIMIT) || 50,
    // AI Concierge. With no key, answers use the deterministic template.
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    // auto | anthropic | ollama | none  (see src/concierge/answer.js)
    conciergeProvider: env.CONCIERGE_PROVIDER || 'auto',
    ollamaUrl: env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL || 'llama3.2:3b',
    conciergeModel: env.CONCIERGE_MODEL || 'claude-opus-5-5',
    conciergeEffort: env.CONCIERGE_EFFORT || 'low',
    // Past this the template answer is used. Claude: 2.5 s, to keep the
    // spec's < 3 s P95. A local CPU model needs far longer (about 8-13 s on a
    // laptop), so it gets 20 s by default; it then misses the 3 s target.
    conciergeTimeoutMs:
      Number(env.CONCIERGE_TIMEOUT_MS) || (env.CONCIERGE_PROVIDER === 'ollama' ? 20000 : 2500),
    // Max Concierge questions per traveller per minute (cost control).
    conciergeRateLimit: Number(env.CONCIERGE_RATE_LIMIT) || 20,
    // Default length of a contested-slot vote.
    voteSeconds: Number(env.VOTE_SECONDS) || 120,
  };
}
