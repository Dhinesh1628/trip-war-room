import express from 'express';
import { z } from 'zod';
import { User } from '../auth/user.model.js';
import { requireAuth } from '../auth/middleware.js';
import { validate } from '../lib/validate.js';
import { DIETARY_TAGS } from '../venues/vocabulary.js';
import { bus, USER_CHANGED } from '../lib/bus.js';
import { buildDashboard } from './dashboard.js';

// Travellers declare dietary needs and a budget ceiling here. budgetCeiling is
// the most this traveller wants to spend in total on the trip's itinerary
// (USD, per person). The Concierge and the conflict detector read both.
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
        budgetCeiling: z.number().positive().max(100000).nullable().optional(),
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

  return router;
}
