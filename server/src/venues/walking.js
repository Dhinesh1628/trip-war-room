// Real walking distances between venues, from OpenStreetMap footpaths
// (computed once when the dataset is built; see the dataset's `walking`
// field). Venue ids are unique across destinations, so one registry serves
// every city. When a pair has no stored route (or a dataset has none, like
// the Lisbon test fixture), callers fall back to a straight-line estimate.

const pairs = new Map(); // venueId -> { index, meters, venueIds }
const byDestination = new Map(); // slug -> walking matrix

// Average city walking pace, 4.8 km/h.
export const METERS_PER_MINUTE = 80;

export function registerWalking(slug, walking) {
  const old = byDestination.get(slug);
  if (old) for (const id of old.venueIds) pairs.delete(id);
  byDestination.delete(slug);
  if (!walking?.venueIds?.length) return;
  byDestination.set(slug, walking);
  walking.venueIds.forEach((id, index) => pairs.set(id, { index, walking }));
}

export function clearWalking() {
  pairs.clear();
  byDestination.clear();
}

// Footpath metres from one venue to another, or null if unknown.
export function walkingMeters(fromVenueId, toVenueId) {
  const a = pairs.get(fromVenueId);
  const b = pairs.get(toVenueId);
  if (!a || !b || a.walking !== b.walking) return null;
  const m = a.walking.meters[a.index]?.[b.index];
  return typeof m === 'number' ? m : null;
}

// Whole minutes on foot (at least 1), or null if no route is stored.
export function routedWalkMinutes(fromVenueId, toVenueId) {
  const m = walkingMeters(fromVenueId, toVenueId);
  return m == null ? null : Math.max(1, Math.round(m / METERS_PER_MINUTE));
}
