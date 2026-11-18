import express from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { ingestDataset } from '../venues/ingest.js';
import { validateDataset } from '../venues/datasetSchema.js';
import { Destination } from '../venues/destination.model.js';
import { Venue } from '../venues/venue.model.js';

// Admin-only venue dataset management (spec 6.3). Every route here is
// rejected server-side for non-admin tokens, regardless of what the UI shows.
export function adminRouter(config) {
  const router = express.Router();
  router.use(requireAuth(config), requireAdmin);

  router.get('/datasets', async (req, res) => {
    const [destinations, counts] = await Promise.all([
      Destination.find().sort({ name: 1 }).lean(),
      Venue.aggregate([{ $group: { _id: '$destination', count: { $sum: 1 } } }]),
    ]);
    const countBy = Object.fromEntries(counts.map((c) => [c._id, c.count]));
    res.json({
      datasets: destinations.map((d) => ({
        slug: d.slug,
        name: d.name,
        datasetVersion: d.datasetVersion,
        venueCount: countBy[d.slug] ?? 0,
        updatedAt: d.updatedAt,
      })),
    });
  });

  // Checks a dataset without saving it, so an admin can fix errors first.
  router.post('/datasets/validate', (req, res) => {
    const result = validateDataset(req.body);
    if (!result.ok) {
      return res.status(400).json({
        valid: false,
        error: { code: 'VALIDATION_FAILED', message: 'Dataset is invalid', details: result.errors },
      });
    }
    res.json({ valid: true, destination: result.data.destination.slug, venues: result.data.venues.length });
  });

  // Validates and loads a dataset, replacing that destination's venues.
  router.post('/datasets', async (req, res) => {
    const summary = await ingestDataset(req.body);
    res.status(201).json({ summary });
  });

  return router;
}
