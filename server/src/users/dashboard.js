import { DEFAULT_CURRENCY } from '../lib/money.js';
import { findDestination } from '../venues/catalog.js';
import { Trip } from '../trips/trip.model.js';
import { Interaction } from '../recs/interaction.model.js';
import { Venue } from '../venues/venue.model.js';
import { User } from '../auth/user.model.js';
import { recommendForTrip } from '../recs/service.js';

// The personal dashboard (spec 6.3): trip history, a preference profile built
// from what the traveller actually did, rooms that are live right now, and
// personal recommendations.

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100;
};

export async function buildDashboard(userId, { registry } = {}) {
  const [user, trips, interactions] = await Promise.all([
    User.findById(userId).lean(),
    Trip.find({ 'participants.userId': userId }).sort({ createdAt: -1 }).limit(100).lean(),
    Interaction.find({ userId }).sort({ createdAt: -1 }).limit(2000).lean(),
  ]);

  // Prices and tags of the venues this traveller liked.
  const likedIds = [...new Set(interactions.filter((i) => i.liked).map((i) => i.venueId))];
  const liked = await Venue.find({ _id: { $in: likedIds } }).lean();
  const prices = liked.map((v) => v.pricePerPerson);
  const categoryCounts = {};
  for (const i of interactions.filter((x) => x.liked)) categoryCounts[i.category] = (categoryCounts[i.category] ?? 0) + 1;
  const tagCounts = {};
  for (const v of liked) for (const t of v.dietaryTags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  const top = (counts, n) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([name, count]) => ({ name, count }));

  const tripRows = trips.map((t) => {
    const me = t.participants.find((p) => String(p.userId) === String(userId));
    const live = registry?.get(String(t._id));
    return {
      tripId: String(t._id),
      destination: t.destinationName,
      startDate: t.startDate,
      endDate: t.endDate,
      status: t.status,
      myRole: me?.role ?? null,
      participantCount: t.participants.length,
      onlineNow: live ? live.presence.size : 0,
    };
  });

  // Recommendations for me, for the destination of my latest trip.
  const latest = trips[0];
  const recs = latest
    ? await recommendForTrip({ destination: latest.destination, memberIds: [String(userId)], limit: 5 })
    : { recommendations: [], model: null };

  return {
    user: { userId: String(userId), displayName: user?.displayName ?? null },
    trips: {
      led: tripRows.filter((t) => t.myRole === 'leader'),
      joined: tripRows.filter((t) => t.myRole !== 'leader'),
    },
    // Rooms with people in them right now: quick rejoin.
    activeRooms: tripRows.filter((t) => t.onlineNow > 0),
    preferenceProfile: {
      declared: {
        dietaryTags: user?.preferences?.dietaryTags ?? [],
        budgetCeiling: user?.preferences?.budgetCeiling ?? null,
      },
      fromHistory: {
        signals: interactions.length,
        favouriteCategories: top(categoryCounts, 3),
        dietaryTagsOfLikedPlaces: top(tagCounts, 3),
        priceRange: prices.length
          ? { min: Math.min(...prices), median: median(prices), max: Math.max(...prices), currency: liked.length ? (await findDestination(liked[0].destination))?.currency ?? DEFAULT_CURRENCY : DEFAULT_CURRENCY }
          : null,
      },
    },
    recommendations: recs.recommendations,
    recommendationsFor: latest ? latest.destinationName : null,
  };
}
