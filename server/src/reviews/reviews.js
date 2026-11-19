import { Review } from './review.model.js';

// Per-venue review summaries ({ count, average }), cached per destination and
// cleared whenever a review in that destination changes.
const cache = new Map(); // destination -> Map venueId -> { count, average }

export async function reviewSummaries(destination) {
  if (cache.has(destination)) return cache.get(destination);
  const rows = await Review.aggregate([
    { $match: { destination } },
    { $group: { _id: '$venueId', count: { $sum: 1 }, average: { $avg: '$rating' } } },
  ]);
  const map = new Map(rows.map((r) => [r._id, { count: r.count, average: Math.round(r.average * 10) / 10 }]));
  cache.set(destination, map);
  return map;
}

export function clearReviewCache(destination) {
  if (destination) cache.delete(destination);
  else cache.clear();
}

// A venue as the API returns it, with its traveller-review summary.
export async function withReviews(destination, venues) {
  const map = await reviewSummaries(destination);
  return venues.map((v) => ({ ...v, travellerReviews: map.get(v.venueId) ?? { count: 0, average: null } }));
}
