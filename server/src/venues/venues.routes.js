import mongoose from 'mongoose';
import { Review } from '../reviews/review.model.js';
import { reviewSummaries, clearReviewCache, withReviews } from '../reviews/reviews.js';
import { User } from '../auth/user.model.js';
import { sanitizeChat } from '../chat/sanitize.js';
import { routedWalkMinutes } from './walking.js';
import { walkMinutes } from '../concierge/constraints.js';
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
const reviewSchema = z
  .object({
    rating: z.number().int('rating must be a whole number of stars').min(1, 'rating is 1 to 5 stars').max(5, 'rating is 1 to 5 stars'),
    text: z.string().max(1000, 'A review can be at most 1,000 characters').optional().default(''),
  })
  .strict();

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
    const found = await searchVenues(d.slug, req.valid.query);
    const radiusKm = found.radiusKm;
    const venues = await withReviews(d.slug, found.venues);
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

  async function venueOr404({ destination, venueId }) {
    const d = await findDestination(destination);
    if (!d) throw notFound('Destination not found');
    const venue = (await venuesFor(d.slug)).find((v) => v._id === venueId);
    if (!venue) throw notFound('Venue not found');
    return { d, venue };
  }

  router.get('/:destination/venues/:venueId', async (req, res) => {
    const d = await findDestination(req.params.destination);
    if (!d) throw notFound('Destination not found');
    const venue = (await venuesFor(d.slug)).find((v) => v._id === req.params.venueId);
    if (!venue) throw notFound('Venue not found');
    // The three closest places on foot (real footpaths when known).
    const others = (await venuesFor(d.slug)).filter((v) => v._id !== venue._id);
    const nearby = others
      .map((v) => {
        const routed = routedWalkMinutes(venue._id, v._id);
        const km = distanceKm(venue.coordinates, v.coordinates);
        return { venueId: v._id, name: v.name, category: v.category, walkMinutes: routed ?? walkMinutes(km), routed: routed != null, km };
      })
      .sort((a, b) => a.walkMinutes - b.walkMinutes || a.km - b.km)
      .slice(0, 3)
      .map(({ km, ...rest }) => rest); // eslint-disable-line no-unused-vars
    const [withSummary] = await withReviews(d.slug, [venue.toPublic()]);
    res.json({ destination: d.name, venue: withSummary, nearby });
  });

  // Reviews of a place, newest first, plus your own if you wrote one.
  router.get('/:destination/venues/:venueId/reviews', async (req, res) => {
    const { d, venue } = await venueOr404(req.params);
    const rows = await Review.find({ venueId: venue._id }).sort({ updatedAt: -1, _id: -1 }).limit(100).lean();
    const names = new Map(
      (await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('displayName').lean()).map((u) => [String(u._id), u.displayName]),
    );
    const summary = (await reviewSummaries(d.slug)).get(venue._id) ?? { count: 0, average: null };
    const pub = (r) => ({ reviewId: String(r._id), userId: String(r.userId), displayName: names.get(String(r.userId)) ?? 'A traveller', rating: r.rating, text: r.text, createdAt: r.createdAt, updatedAt: r.updatedAt });
    res.json({ summary, reviews: rows.map(pub), mine: rows.filter((r) => String(r.userId) === req.user.id).map(pub)[0] ?? null });
  });

  // Write or replace your review. Text is cleaned like chat (no HTML).
  router.put('/:destination/venues/:venueId/reviews', validate(reviewSchema), async (req, res) => {
    const { d, venue } = await venueOr404(req.params);
    const text = sanitizeChat(req.valid.body.text ?? '');
    const r = await Review.findOneAndUpdate(
      { venueId: venue._id, userId: req.user.id },
      { $set: { rating: req.valid.body.rating, text, destination: d.slug } },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
    );
    clearReviewCache(d.slug);
    // A review is also a taste signal: 4-5 stars a like, 1-2 a dislike.
    if (r.rating !== 3) {
      await Interaction.create({ userId: req.user.id, destination: d.slug, venueId: venue._id, category: venue.category, liked: r.rating >= 4, weight: 2, source: 'feedback' });
    }
    res.json({ review: { reviewId: String(r._id), rating: r.rating, text: r.text, updatedAt: r.updatedAt } });
  });

  // Delete your review (an admin can delete anyone's with ?userId=).
  router.delete('/:destination/venues/:venueId/reviews', async (req, res) => {
    const { d, venue } = await venueOr404(req.params);
    const target = req.query.userId && req.user.role === 'admin' ? String(req.query.userId) : req.user.id;
    if (!mongoose.isValidObjectId(target)) throw notFound('Review not found');
    const gone = await Review.deleteOne({ venueId: venue._id, userId: target });
    if (!gone.deletedCount) throw notFound('Review not found');
    clearReviewCache(d.slug);
    res.status(204).end();
  });

  return router;
}
