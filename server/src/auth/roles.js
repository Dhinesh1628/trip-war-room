// Four-tier role model (spec 10.1): Viewer < Planner < Leader < Admin.
//
// - Admin is an ACCOUNT role (user.role === 'admin'). It manages venue
//   datasets and outranks everyone in every trip.
// - Viewer / Planner / Leader are TRIP roles, stored per participant on each
//   trip, because the same person can lead one trip and only view another.
//
// These are plain functions so the REST API and the WebSocket gateway use the
// exact same rules.

export const ACCOUNT_ROLES = Object.freeze(['user', 'admin']);
export const TRIP_ROLES = Object.freeze(['viewer', 'planner', 'leader']);

const RANK = Object.freeze({ viewer: 1, planner: 2, leader: 3, admin: 4 });

// What a user may do in a given trip: 'admin', 'leader', 'planner', 'viewer',
// or null when they are not a participant.
export function effectiveTripRole(user, trip) {
  if (!user || !trip) return null;
  if (user.role === 'admin') return 'admin';
  const me = trip.participants.find((p) => String(p.userId) === String(user.id));
  return me ? me.role : null;
}

// True when `role` is at least as powerful as `minimum`.
export function atLeast(role, minimum) {
  if (!role || !RANK[minimum]) return false;
  return (RANK[role] || 0) >= RANK[minimum];
}
