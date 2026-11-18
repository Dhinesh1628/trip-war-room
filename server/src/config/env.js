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
  };
}
