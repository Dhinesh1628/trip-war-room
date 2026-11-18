// Reads settings from environment variables. Secrets are never hard-coded:
// the server refuses to start without them (tests pass their own values).
export function loadConfig(env = process.env) {
  const required = ['MONGO_URI', 'JWT_SECRET'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    port: Number(env.PORT) || 5060,
    mongoUri: env.MONGO_URI,
    jwtSecret: env.JWT_SECRET,
    clientOrigin: env.CLIENT_ORIGIN || 'http://localhost:5180',
    nodeEnv: env.NODE_ENV || 'development',
  };
}
