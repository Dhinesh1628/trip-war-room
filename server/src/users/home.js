import { Trip } from '../trips/trip.model.js';
import { TripInvite } from '../trips/tripInvite.model.js';
import { ItineraryItem } from '../board/itineraryItem.model.js';
import { TripEvent } from '../board/tripEvent.model.js';
import { Vote } from '../board/vote.model.js';
import { computeBudget } from '../board/budgetEngine.js';
import { detectConflicts } from '../concierge/conflicts.js';
import { Review } from '../reviews/review.model.js';
import { User } from '../auth/user.model.js';
import { findDestination, venuesFor } from '../venues/catalog.js';
import { DEFAULT_CURRENCY } from '../lib/money.js';

// The signed-in home page: summary numbers, the next trip at a glance,
// email invitations waiting, and recent activity across your trips.

const ACTIVITY_TYPES = ['item_pinned', 'item_locked', 'item_removed', 'vote_resolved', 'ai_asked', 'conflict_opened'];
const todayIso = () => new Date().toISOString().slice(0, 10);

export async function buildHome(userId, { registry } = {}) {
  const uid = String(userId);
  const today = todayIso();
  const [user, trips, savedCount, reviewCount] = await Promise.all([
    User.findById(uid).select('email savedVenueIds').lean(),
    Trip.find({ 'participants.userId': uid }).sort({ startDate: 1 }).limit(100).lean(),
    User.findById(uid).select('savedVenueIds').lean().then((u) => u?.savedVenueIds?.length ?? 0),
    Review.countDocuments({ userId: uid }),
  ]);
  const upcoming = trips.filter((t) => t.endDate >= today);
  const tripIds = trips.map((t) => t._id);

  // My share of what's on each upcoming board, from the budget engine.
  const [items, openVotes] = await Promise.all([
    ItineraryItem.find({ tripId: { $in: upcoming.map((t) => t._id) } }).lean(),
    Vote.countDocuments({ tripId: { $in: upcoming.map((t) => t._id) }, status: 'open' }),
  ]);
  const itemsByTrip = new Map();
  for (const i of items) {
    const k = String(i.tripId);
    if (!itemsByTrip.has(k)) itemsByTrip.set(k, []);
    itemsByTrip.get(k).push(i);
  }
  const ordered = (list) => [...list].sort((a, b) => a.dayIndex - b.dayIndex || a.startTime.localeCompare(b.startTime) || String(a._id).localeCompare(String(b._id)));
  let plannedSpend = 0;
  let currency = DEFAULT_CURRENCY;
  for (const t of upcoming) {
    const b = computeBudget({ items: ordered(itemsByTrip.get(String(t._id)) ?? []), participantIds: t.participants.map((p) => String(p.userId)), totalBudget: t.totalBudget });
    plannedSpend += (b.perPersonCents[uid] ?? 0) / 100;
    currency = t.currency || currency;
  }

  // The next trip in detail.
  let nextTrip = null;
  const next = upcoming[0];
  if (next) {
    const nItems = ordered(itemsByTrip.get(String(next._id)) ?? []);
    const people = next.participants.map((p) => String(p.userId));
    const budget = computeBudget({ items: nItems, participantIds: people, totalBudget: next.totalBudget });
    const live = registry?.get(String(next._id));
    const conflicts = live
      ? live.conflicts.length
      : detectConflicts({ items: nItems, participantIds: people, travellers: new Map(), totalBudget: next.totalBudget, currency: next.currency }).length;
    const daysToGo = Math.round((Date.parse(`${next.startDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    const dest = await findDestination(next.destination);
    nextTrip = {
      tripId: String(next._id),
      destination: next.destinationName,
      destinationSlug: next.destination,
      startDate: next.startDate,
      endDate: next.endDate,
      daysToGo,
      myRole: next.participants.find((p) => String(p.userId) === uid)?.role ?? null,
      participantCount: people.length,
      onlineNow: live ? live.presence.size : 0,
      pinned: nItems.length,
      openVotes: await Vote.countDocuments({ tripId: next._id, status: 'open' }),
      conflicts,
      groupCommitted: budget.groupCommitted,
      totalBudget: budget.totalBudget,
      currency: next.currency || dest?.currency || DEFAULT_CURRENCY,
      image: dest?.image?.url ? dest.image : null,
    };
  }

  // Email invitations to trips I'm not in yet.
  let invitations = [];
  if (user?.email) {
    const invites = await TripInvite.find({ email: user.email }).sort({ createdAt: -1 }).limit(20).lean();
    const inviteTrips = await Trip.find({ _id: { $in: invites.map((i) => i.tripId) } }).lean();
    const byId = new Map(inviteTrips.map((t) => [String(t._id), t]));
    const inviterNames = new Map(
      (await User.find({ _id: { $in: invites.map((i) => i.invitedBy) } }).select('displayName').lean()).map((u) => [String(u._id), u.displayName]),
    );
    invitations = invites
      .map((i) => ({ invite: i, trip: byId.get(String(i.tripId)) }))
      .filter(({ trip }) => trip && trip.endDate >= today && !trip.participants.some((p) => String(p.userId) === uid))
      .map(({ invite, trip }) => ({
        tripId: String(trip._id),
        destination: trip.destinationName,
        startDate: trip.startDate,
        endDate: trip.endDate,
        inviteCode: trip.inviteCode,
        invitedBy: inviterNames.get(String(invite.invitedBy)) ?? null,
        invitedAt: invite.createdAt,
      }));
  }

  // Recent activity across my trips.
  const events = await TripEvent.find({ tripId: { $in: tripIds }, type: { $in: ACTIVITY_TYPES } }).sort({ seq: -1 }).limit(8).lean();
  const names = new Map(
    (await User.find({ _id: { $in: events.map((e) => e.userId).filter(Boolean) } }).select('displayName').lean()).map((u) => [String(u._id), u.displayName]),
  );
  const tripName = new Map(trips.map((t) => [String(t._id), t.destinationName.split(',')[0]]));
  const venueNames = new Map();
  for (const slug of new Set(trips.map((t) => t.destination))) for (const v of await venuesFor(slug)) venueNames.set(v._id, v.name);
  const itemVenue = new Map(
    (await ItineraryItem.find({ _id: { $in: events.map((e) => e.itemId).filter(Boolean) } }).select('venueId').lean()).map((i) => [String(i._id), i.venueId]),
  );
  const activity = events.map((e) => {
    const venueId = e.data?.venueId ?? itemVenue.get(String(e.itemId));
    return {
      type: e.type,
      tripId: String(e.tripId),
      trip: tripName.get(String(e.tripId)) ?? null,
      who: e.userId ? (String(e.userId) === uid ? 'You' : names.get(String(e.userId)) ?? 'Someone') : null,
      place: e.data?.name ?? (venueId ? venueNames.get(venueId) ?? null : null),
      at: e.ts,
    };
  });

  return {
    stats: { upcomingTrips: upcoming.length, plannedSpend: Math.round(plannedSpend * 100) / 100, currency, savedPlaces: savedCount, reviewsWritten: reviewCount, openVotes },
    nextTrip,
    invitations,
    activity,
  };
}
