import { CURRENCY_CODES } from '../lib/money.js';
import { z } from 'zod';
import { DIETARY_TAGS, VENUE_CATEGORIES, TRANSIT_MODES, WEATHER_CONDITIONS } from './vocabulary.js';
import { distanceKm } from './geo.js';
import { formatIssues } from '../lib/validate.js';

// The rules every destination dataset must pass, whether it comes from the
// seed file or (Phase 4) an admin upload. Spec 6.3: price must be positive,
// dietary tags must come from the documented vocabulary, coordinates must be
// valid lat/lng, hours must be valid time ranges.

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/; // 00:00 - 23:59
const MAX_DISTANCE_FROM_CENTER_KM = 60;

const money = (label) =>
  z
    .number({ error: `${label} must be a number` })
    .positive(`${label} must be a positive number`)
    .max(100000, `${label} is unrealistically large`)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, {
      message: `${label} can have at most 2 decimal places`,
    });

const coordinates = z.object({
  lat: z.number().min(-90, 'Latitude must be between -90 and 90').max(90, 'Latitude must be between -90 and 90'),
  lng: z
    .number()
    .min(-180, 'Longitude must be between -180 and 180')
    .max(180, 'Longitude must be between -180 and 180'),
});

const hours = z
  .object({
    open: z.string().regex(TIME, 'Opening time must be HH:MM (00:00-23:59)'),
    close: z.string().regex(TIME, 'Closing time must be HH:MM (00:00-23:59)'),
  })
  .refine((h) => h.open !== h.close, {
    message: 'Opening and closing times cannot be equal (use 00:00-23:59 for always open)',
    path: ['close'],
  });

// A photo with its credit. Only Wikimedia Commons images are accepted, so the
// browser's content policy can stay narrow and every photo has a free licence.
const image = z
  .object({
    url: z
      .string()
      .regex(
        /^(\/photos\/[a-z0-9-]+\.(jpg|png)|https:\/\/(upload|thumb)\.wikimedia\.org\/[^?#]+)$/,
        'image.url must be a /photos/ file or an https://upload.wikimedia.org/ or thumb.wikimedia.org/ address with no query string',
      ),
    credit: z.string().trim().min(1).max(160),
    license: z.string().trim().min(2).max(60),
    source: z.string().url().regex(/^https:\/\/commons\.wikimedia\.org\//, 'image.source must be the Commons file page'),
    // true when the photo shows a related dish, street or landmark rather than the venue itself
    representative: z.boolean().optional(),
  })
  .strict();

const venue = z
  .object({
    venueId: z.string().regex(/^v_[a-z0-9_]{1,40}$/, 'venueId must look like v_jai_001'),
    name: z.string().trim().min(1).max(120),
    category: z.enum(VENUE_CATEGORIES, { error: `category must be one of: ${VENUE_CATEGORIES.join(', ')}` }),
    neighborhood: z.string().trim().min(1).max(80),
    pricePerPerson: money('pricePerPerson'),
    dietaryTags: z
      .array(z.enum(DIETARY_TAGS, { error: `dietary tag must be one of: ${DIETARY_TAGS.join(', ')}` }))
      .refine((tags) => new Set(tags).size === tags.length, 'dietaryTags contains duplicates'),
    hours,
    coordinates,
    rating: z.number().min(0).max(5),
    reviewCount: z.number().int().min(0),
    indoor: z.boolean(),
    description: z.string().trim().min(10, 'description must be at least 10 characters').max(600),
    image: image.optional(),
  })
  .strict();

const transitLink = z
  .object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    mode: z.enum(TRANSIT_MODES),
    minutes: z.number().positive().max(600),
    costPerPerson: z.number().min(0).max(100000),
    line: z.string().trim().max(60).optional(),
  })
  .strict();

const weatherBase = {
  condition: z.enum(WEATHER_CONDITIONS),
  highC: z.number().min(-60).max(60),
  lowC: z.number().min(-60).max(60),
};

const monthly = z
  .object({ month: z.number().int().min(1).max(12), ...weatherBase, rainDays: z.number().int().min(0).max(31) })
  .strict()
  .refine((w) => w.lowC <= w.highC, { message: 'lowC cannot be above highC', path: ['lowC'] });

const daily = z
  .object({
    date: z.iso.date({ error: 'date must be YYYY-MM-DD' }),
    ...weatherBase,
    precipitationChance: z.number().min(0).max(100),
  })
  .strict()
  .refine((w) => w.lowC <= w.highC, { message: 'lowC cannot be above highC', path: ['lowC'] });

export const datasetSchema = z
  .object({
    datasetVersion: z.string().trim().min(1).max(40),
    about: z.string().trim().max(1000).optional(),
    destination: z
      .object({
        slug: z.string().regex(/^[a-z0-9-]{2,40}$/, 'slug must be lowercase letters, digits or dashes'),
        name: z.string().trim().min(2).max(100),
        country: z.string().trim().min(2).max(60),
        timezone: z.string().trim().min(3).max(60),
        currency: z.enum(CURRENCY_CODES, { error: `currency must be one of: ${CURRENCY_CODES.join(', ')}` }),
        center: coordinates,
        image: image.optional(),
      })
      .strict(),
    venues: z.array(venue).min(1, 'A dataset needs at least one venue').max(5000),
    transit: z.array(transitLink).max(2000).default([]),
    // Footpath metres between venues (OpenStreetMap), meters[i][j] from venueIds[i] to venueIds[j].
    walking: z
      .object({
        venueIds: z.array(z.string()).max(2000),
        meters: z.array(z.array(z.number().min(0).max(500000).nullable())),
      })
      .strict()
      .optional(),
    weather: z
      .object({ monthly: z.array(monthly).max(12).default([]), daily: z.array(daily).max(400).default([]) })
      .strict()
      .default({ monthly: [], daily: [] }),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set();
    data.venues.forEach((v, i) => {
      if (seen.has(v.venueId)) {
        ctx.addIssue({ code: 'custom', path: ['venues', i, 'venueId'], message: `Duplicate venueId ${v.venueId}` });
      }
      seen.add(v.venueId);
      const km = distanceKm(data.destination.center, v.coordinates);
      if (km > MAX_DISTANCE_FROM_CENTER_KM) {
        ctx.addIssue({
          code: 'custom',
          path: ['venues', i, 'coordinates'],
          message: `Venue is ${km.toFixed(0)} km from the destination centre (max ${MAX_DISTANCE_FROM_CENTER_KM}); check lat/lng order`,
        });
      }
    });
    if (data.walking) {
      const ids = new Set(data.venues.map((v) => v.venueId));
      const w = data.walking;
      if (w.venueIds.some((id) => !ids.has(id)) || new Set(w.venueIds).size !== w.venueIds.length) {
        ctx.addIssue({ code: 'custom', path: ['walking', 'venueIds'], message: 'walking.venueIds must be distinct venue ids from this dataset' });
      }
      if (w.meters.length !== w.venueIds.length || w.meters.some((row) => row.length !== w.venueIds.length)) {
        ctx.addIssue({ code: 'custom', path: ['walking', 'meters'], message: 'walking.meters must be a square table matching walking.venueIds' });
      }
    }
    const months = data.weather.monthly.map((m) => m.month);
    if (new Set(months).size !== months.length) {
      ctx.addIssue({ code: 'custom', path: ['weather', 'monthly'], message: 'Each month may appear only once' });
    }
    const dates = data.weather.daily.map((d) => d.date);
    if (new Set(dates).size !== dates.length) {
      ctx.addIssue({ code: 'custom', path: ['weather', 'daily'], message: 'Each date may appear only once' });
    }
  });

// Returns { ok: true, data } or { ok: false, errors: [{ path, message }] }.
export function validateDataset(input) {
  const result = datasetSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: formatIssues(result.error.issues) };
}
