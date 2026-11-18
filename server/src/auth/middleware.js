import { verifyAccessToken } from './tokens.js';
import { User } from './user.model.js';
import { forbidden, unauthorized } from '../lib/errors.js';

// Verifies a JWT, then re-reads the user so a role change (e.g. admin removed)
// or a deleted account takes effect immediately, not when the token expires.
// Shared by REST and the WebSocket handshake.
export async function authenticate(token, config) {
  const claims = verifyAccessToken(token, config);
  const user = await User.findById(claims.id).select('role displayName').lean();
  if (!user) throw unauthorized('Account no longer exists', 'INVALID_TOKEN');
  return { id: String(user._id), role: user.role, name: user.displayName };
}

// Reads "Authorization: Bearer <token>" and sets req.user = { id, role, name }.
export function requireAuth(config) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    req.user = await authenticate(scheme === 'Bearer' ? token : null, config);
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(forbidden('Admin role required'));
  next();
}
