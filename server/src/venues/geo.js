// Small, dependency-free geo helpers. Distances are great-circle (haversine),
// in kilometres. Good to a few metres at city scale.

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A lat/lng rectangle that fully contains the circle. Used to narrow a
// database query (it can use the (destination, lat, lng) index) before the
// exact haversine check.
export function boundingBox(center, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(Math.cos(toRad(center.lat)), 1e-6));
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLng: center.lng - dLng,
    maxLng: center.lng + dLng,
  };
}

// Parses "38.71,-9.13" into { lat, lng }, or returns null if malformed/out of range.
export function parseLatLng(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length !== 2 || parts.some((p) => p === '')) return null;
  const [lat, lng] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
