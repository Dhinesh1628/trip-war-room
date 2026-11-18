// Structured logging (spec 10.3): one JSON object per line, so logs can be
// searched by tripId or correlationId. Never pass passwords, tokens or chat
// bodies in `fields`.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'test' ? LEVELS.silent : LEVELS.info);

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? threshold;
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg, fields = {}) => write('debug', msg, fields),
  info: (msg, fields = {}) => write('info', msg, fields),
  warn: (msg, fields = {}) => write('warn', msg, fields),
  error: (msg, fields = {}) => write('error', msg, fields),
};
