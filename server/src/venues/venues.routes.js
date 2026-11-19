import express from 'express';
import { z } from 'zod';
import { Venue } from './venue.model.js';
import { allDestinations, findDestination, venuesFor } from './catalog.js';
import { boundingBox, distanceKm, parseLatLng } from './geo.js';
import { VENUE_CATEGORIES } from './vocabulary.js';
import { requireAuth } from '../auth/middleware.js';
import { validate } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { Interaction } from '../recs/interaction.model.js';

const DEFAULT_RADIUS_KM = 2;

const feedbackSchema = z.object({ liked: z.boolean() }).strict();

const venueQuery = z
  .object({
    near: z
      .string()
      .transform((s, ctx) => {
        const point = parseLatLng(s);
        if (!point) ctx.addIssue({ code: 'custom', message: 'near must be "lat,lng", e.g. 26.9239,75.8267' });
        return point;
      })
      .optional(),
    radiusKm: z.coerce.number().positive('radiusKm must be positive').max(50, 'radiusKm can be at most 50').optional(),
    category: z.enum(VENUE_CATEGORIES).optional(),
  })
  .strict();

// Accepts a slug ("jaipur") or the display name ("Jaipur, India").
export { findDestination };

// Above this many venues, searches go to the database (bounding box on the
// (destination, lat, lng) index) instead of the in-memory catalog.
const IN_MEMORY_LIMIT = 2000;

// Finds venues in a destination, optionally within radiusKm of a point.
// A lat/lng bounding box narrows the candidates; the exact haversine check
// then removes the box's corners.
export async function searchVenues(slug, { near, radiusKm, category } = {}) {
  let radius = null;
  let box = null;
  if (near) {
    radius = radiusKm ?? DEFAULT_RADIUS_KM;
    box = boundingBox(near, radius);
  }
  const inBox = (v) =>
    !box || (v.coordinates.lat >= box.minLat && v.coordinates.lat <= box.maxLat && v.coordinates.lng >= box.minLng && v.coordinates.lng <= box.maxLng);

  const cached = await venuesFor(slug);
  let docs;
  if (cached.length <= IN_MEMORY_LIMIT) {
    docs = cached.filter((v) => (!category || v.category === category) && inBox(v));
  } else {
    const filter = { destination: slug };
    if (category) filter.category = category;
    if (box) {
      filter['coordinates.lat'] = { $gte: box.minLat, $lte: box.maxLat };
      filter['coordinates.lng'] = { $gte: box.minLng, $lte: box.maxLng };
    }
    docs = await Venue.find(filter).sort({ _id: 1 });
  }
  let venues = docs.map((d) => d.toPublic());
  if (near) {
    venues = venues
      .map((v) => ({ ...v, distanceKm: Math.round(distanceKm(near, v.coordinates) * 1000) / 1000 }))
      .filter((v) => v.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm || a.venueId.localeCompare(b.venueId));
  }
  return { venues, radiusKm: radius };
}

export function destinationsRouter(config) {
  const router = express.Router();
  router.use(requireAuth(config));

  router.get('/', async (req, res) => {
    const destinations = await allDestinations();
    const countBy = Object.fromEntries(
      await Promise.all(destinations.map(async (d) => [d.slug, (await venuesFor(d.slug)).length])),
    );
    res.json({
      destinations: destinations.map((d) => ({
        slug: d.slug,
        name: d.name,
        country: d.country,
        center: d.center,
        currency: d.currency,
        image: d.image?.url ? d.image : null,
        venueCount: countBy[d.slug] ?? 0,
        datasetVersion: d.datasetVersion,
      })),
    });
  });

  router.get('/:destination', async (req, res) => {
    const d = await findDestination(req.params.destination);
    if (!d) throw notFound('Destination not found');
    res.json({
      slug: d.slug,
      name: d.name,
      country: d.country,
      timezone: d.timezone,
      currency: d.currency,
      center: d.center,
      image: d.image?.url ? d.image : null,
      datasetVersion: d.datasetVersion,
      transit: d.transit,
      weather: d.weather,
    });
  });

  // Spec 7.3.2: GET /destinations/{destination}/venues?near={lat,lng}&radiusKm={n}
  router.get('/:destination/venues', validate(venueQuery, 'query'), async (req, res) => {
    const d = await findDestination(req.params.destination);
    if (!d) throw notFound('Destination not found');
    const { venues, radiusKm } = await searchVenues(d.slug, req.valid.query);
    res.json({
      destination: d.name,
      slug: d.slug,
      ...(req.valid.query.near ? { near: req.valid.query.near, radiusKm } : {}),
      count: venues.length,
      venues,
    });
  });

  // An explicit like or dislike: a strong signal for recommendations.
  router.post('/:destination/venues/:venueId/feedback', validate(feedbackSchema), async (req, res) => {
    const d = await findDestination(req.params.destination);
    if (!d) throw notFound('Destination not found');
    const venue = (await venuesFor(d.slug)).find((v) => v._id === req.params.venueId);
    if (!venue) throw notFound('Venue not found');
    await Interaction.create({
      userId: req.user.id,
      destination: d.slug,
      venueId: venue._id,
      category: venue.category,
      liked: req.valid.body.liked,
      weight: 2,
      source: 'feedback',
    });
    res.status(201).json({ venueId: venue._id, liked: req.valid.body.liked });
  });

  router.get('/:destination/venues/:venueId', async (req, res) => {
    const d = await findDestination(req.params.destination);
    if (!d) throw notFound('Destination not found');
    const venue = (await venuesFor(d.slug)).find((v) => v._id === req.params.venueId);
    if (!venue) throw notFound('Venue not found');
    res.json({ destination: d.name, venue: venue.toPublic() });
  });

  return router;
}
