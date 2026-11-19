import express from 'express';
import { z } from 'zod';
import { User } from '../auth/user.model.js';
import { requireAuth } from '../auth/middleware.js';
import { validate } from '../lib/validate.js';
import { DIETARY_TAGS } from '../venues/vocabulary.js';
import { bus, USER_CHANGED } from '../lib/bus.js';
import { buildDashboard } from './dashboard.js';
import { Venue } from '../venues/venue.model.js';
import { Interaction } from '../recs/interaction.model.js';
import { allDestinations } from '../venues/catalog.js';
import { notFound } from '../lib/errors.js';

export const MAX_SAVED = 200;

// A saved place as the client shows it: the venue plus its city.
async function savedList(ids) {
  if (!ids.length) return [];
  const [docs, destinations] = await Promise.all([Venue.find({ _id: { $in: ids } }), allDestinations()]);
  const byId = new Map(docs.map((d) => [d._id, d]));
  const names = new Map(destinations.map((d) => [d.slug, d]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const d = byId.get(id);
      const dest = names.get(d.destination);
      return { ...d.toPublic(), destination: d.destination, destinationName: dest?.name ?? d.destination, currency: dest?.currency ?? 'INR' };
    });
}

// Travellers declare dietary needs and a budget ceiling here. budgetCeiling is
// the most this traveller wants to spend in total on the trip's itinerary
// (in the trip's currency, per person). The Concierge and the conflict detector read both.
const updateMeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    preferences: z
      .object({
        dietaryTags: z
          .array(z.enum(DIETARY_TAGS))
          .max(DIETARY_TAGS.length)
          .transform((tags) => [...new Set(tags)])
          .optional(),
        budgetCeiling: z.number().positive().max(10_000_000).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function usersRouter(config, { gateway } = {}) {
  const router = express.Router();

  // Personal dashboard (spec 6.3).
  router.get('/me/dashboard', requireAuth(config), async (req, res) => {
    res.json(await buildDashboard(req.user.id, { registry: gateway?.registry }));
  });

  router.patch('/me', requireAuth(config), validate(updateMeSchema), async (req, res) => {
    const { displayName, preferences } = req.valid.body;
    const set = {};
    if (displayName !== undefined) set.displayName = displayName;
    if (preferences?.dietaryTags !== undefined) set['preferences.dietaryTags'] = preferences.dietaryTags;
    if (preferences?.budgetCeiling !== undefined) set['preferences.budgetCeiling'] = preferences.budgetCeiling;

    const user = await User.findByIdAndUpdate(req.user.id, { $set: set }, { returnDocument: 'after', runValidators: true });
    bus.emit(USER_CHANGED, { userId: req.user.id });
    res.json({ user: user.toPublic() });
  });

  // Saved places (the heart button). Saving also counts as a like for the
  // recommendation engine.
  router.get('/me/saved', requireAuth(config), async (req, res) => {
    const user = await User.findById(req.user.id).select('savedVenueIds').lean();
    res.json({ saved: await savedList(user?.savedVenueIds ?? []) });
  });

  router.put('/me/saved/:venueId', requireAuth(config), async (req, res) => {
    const venue = await Venue.findById(String(req.params.venueId));
    if (!venue) throw notFound('Venue not found');
    const user = await User.findById(req.user.id).select('savedVenueIds');
    const ids = [venue._id, ...(user.savedVenueIds ?? []).filter((id) => id !== venue._id)].slice(0, MAX_SAVED);
    const already = (user.savedVenueIds ?? []).includes(venue._id);
    user.savedVenueIds = ids;
    await user.save();
    if (!already) {
      await Interaction.create({ userId: req.user.id, destination: venue.destination, venueId: venue._id, category: venue.category, liked: true, weight: 2, source: 'feedback' });
    }
    res.json({ savedVenueIds: ids });
  });

  router.delete('/me/saved/:venueId', requireAuth(config), async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $pull: { savedVenueIds: String(req.params.venueId) } },
      { returnDocument: 'after' },
    ).select('savedVenueIds');
    res.json({ savedVenueIds: user?.savedVenueIds ?? [] });
  });

  return router;
}
