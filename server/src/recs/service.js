import { Interaction } from './interaction.model.js';
import { Venue } from '../venues/venue.model.js';
import { buildModel, recommendForGroup, ALPHA } from './recommender.js';

// Live recommendations. The model is rebuilt from the interactions
// collection whenever a new interaction has arrived since the last build
// (spec 6.3: the rail updates without a retrain-and-redeploy cycle). At this
// project's scale a rebuild takes milliseconds; a larger system would update
// the user-venue matrix incrementally or retrain on a schedule.

const cache = new Map(); // destination -> { stamp, model, interactionCount, userCount }

async function modelFor(destination) {
  const [latest, count] = await Promise.all([
    Interaction.findOne({ destination }).sort({ createdAt: -1, _id: -1 }).select('_id').lean(),
    Interaction.countDocuments({ destination }),
  ]);
  const stamp = `${latest?._id ?? 'none'}:${count}`;
  const hit = cache.get(destination);
  if (hit && hit.stamp === stamp) return hit;

  const [rows, venues] = await Promise.all([
    Interaction.find({ destination }).select('userId venueId liked weight coTraveledWith').lean(),
    Venue.find({ destination }),
  ]);
  const model = buildModel(
    rows.map((r) => ({ ...r, userId: String(r.userId) })),
    venues.map((v) => v.toPublic()),
  );
  const entry = { stamp, model, interactionCount: rows.length, userCount: model.ratings.size, builtAt: new Date().toISOString() };
  cache.set(destination, entry);
  return entry;
}

export function clearRecommendationCache() {
  cache.clear();
}

// "Recommended for your group" for a trip.
export async function recommendForTrip({ destination, memberIds, excludeVenueIds = [], dietaryTags = [], limit = 5 }) {
  const { model, interactionCount, userCount, builtAt } = await modelFor(destination);
  return {
    recommendations: recommendForGroup(model, memberIds, { exclude: excludeVenueIds, dietaryTags, limit }),
    model: { type: 'hybrid content + collaborative', alpha: ALPHA, interactions: interactionCount, travellers: userCount, builtAt },
  };
}
