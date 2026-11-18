import express from 'express';
import { z } from 'zod';
import { User } from '../auth/user.model.js';
import { requireAuth } from '../auth/middleware.js';
import { validate } from '../lib/validate.js';
import { DIETARY_TAGS } from '../venues/vocabulary.js';

// Travellers declare dietary needs and a per-item budget ceiling here; the AI
// Concierge and conflict detector read them (Phase 3).
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

export function usersRouter(config) {
  const router = express.Router();

  router.patch('/me', requireAuth(config), validate(updateMeSchema), async (req, res) => {
    const { displayName, preferences } = req.valid.body;
    const set = {};
    if (displayName !== undefined) set.displayName = displayName;
    if (preferences?.dietaryTags !== undefined) set['preferences.dietaryTags'] = preferences.dietaryTags;
    if (preferences?.budgetCeiling !== undefined) set['preferences.budgetCeiling'] = preferences.budgetCeiling;

    const user = await User.findByIdAndUpdate(req.user.id, { $set: set }, { returnDocument: 'after', runValidators: true });
    res.json({ user: user.toPublic() });
  });

  return router;
}
