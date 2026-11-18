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
    clientOrigin: env.CLIENT_ORIGIN || 'http://localhost:5180',
    nodeEnv,
    // Access tokens must be short-lived (spec 10.1: <= 1 hour).
    accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS) || 15 * 60,
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS) || 7,
    bcryptRounds: Number(env.BCRYPT_ROUNDS) || 10,
    // Max login/register attempts per IP per 15 minutes.
    authRateLimit: Number(env.AUTH_RATE_LIMIT) || 20,
    secureCookies: nodeEnv === 'production',
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
