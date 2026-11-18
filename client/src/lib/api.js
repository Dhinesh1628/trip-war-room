// Small fetch wrapper for the REST API. The access token is kept in memory
// only (never localStorage); the httpOnly refresh cookie restores the
// session. A request that fails with TOKEN_EXPIRED refreshes once and retries.

let accessToken = null;
let refreshing = null;
const listeners = new Set();

export const getToken = () => accessToken;
export function setToken(token) {
  accessToken = token;
  for (const fn of listeners) fn(token);
}
export function onTokenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

async function raw(method, path, body, token) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

// Exchanges the refresh cookie for a new access token. Concurrent callers share one refresh.
export function refresh() {
  if (!refreshing) {
    refreshing = raw('POST', '/auth/refresh')
      .then((r) => {
        setToken(r.accessToken);
        return r;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function api(method, path, body) {
  try {
    return await raw(method, path, body, accessToken);
  } catch (err) {
    if (err.status === 401 && err.code === 'TOKEN_EXPIRED') {
      await refresh();
      return raw(method, path, body, accessToken);
    }
    throw err;
  }
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body) => api('PATCH', path, body);
