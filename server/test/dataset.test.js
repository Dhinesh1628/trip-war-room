import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import request from 'supertest';
import { startTestServer, registerUser } from './helpers.js';
import { validateDataset } from '../src/venues/datasetSchema.js';
import { ingestDataset } from '../src/venues/ingest.js';
import { DATA_DIR } from '../src/venues/seedData.js';
import { FIXTURE_DIR } from './fixtures.js';
import { DIETARY_TAGS, FOOD_CATEGORIES, VENUE_CATEGORIES } from '../src/venues/vocabulary.js';
import { Venue } from '../src/venues/venue.model.js';
import { isOpenFor } from '../src/concierge/constraints.js';

let lisbon;
const clone = () => structuredClone(lisbon);

beforeAll(async () => {
  lisbon = JSON.parse(await readFile(`${FIXTURE_DIR}/lisbon.json`, 'utf8'));
});

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const openMinutes = ({ open, close }) => (minutes(close) - minutes(open) + 1440) % 1440;

describe('the Lisbon dataset covers every constraint type (spec 14.1)', () => {
  test('passes validation', () => {
    const result = validateDataset(lisbon);
    expect(result.errors).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  test.each(DIETARY_TAGS)('at least one food venue satisfies "%s"', (tag) => {
    const matches = lisbon.venues.filter((v) => FOOD_CATEGORIES.includes(v.category) && v.dietaryTags.includes(tag));
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('some venues breach a typical $25 dinner budget, and some lodging breaches $150/night', () => {
    const dinners = lisbon.venues.filter((v) => v.category === 'dinner');
    expect(dinners.filter((v) => v.pricePerPerson > 25).length).toBeGreaterThanOrEqual(3);
    expect(dinners.filter((v) => v.pricePerPerson <= 25).length).toBeGreaterThanOrEqual(3);
    expect(lisbon.venues.some((v) => v.category === 'lodging' && v.pricePerPerson > 150)).toBe(true);
  });

  test('some venues have restrictive hours (open 4 hours or less) and some stay open past midnight', () => {
    expect(lisbon.venues.filter((v) => openMinutes(v.hours) <= 240).length).toBeGreaterThanOrEqual(3);
    expect(lisbon.venues.some((v) => minutes(v.hours.close) < minutes(v.hours.open))).toBe(true);
  });

  test('has at least one dinner under $25 with a vegetarian option within 600 m of the Alfama tour', () => {
    // The spec's example question: "a dinner spot near our 5 PM tour under $25/person".
    const tour = lisbon.venues.find((v) => v.venueId === 'v_lis_025');
    const close = lisbon.venues.filter(
      (v) =>
        v.category === 'dinner' &&
        v.pricePerPerson <= 25 &&
        v.dietaryTags.includes('vegetarian') &&
        Math.hypot(
          (v.coordinates.lat - tour.coordinates.lat) * 111.32,
          (v.coordinates.lng - tour.coordinates.lng) * 86.9,
        ) <= 0.6,
    );
    expect(close.length).toBeGreaterThanOrEqual(1);
  });

  test('includes lodging at several price points, plus transit and weather', () => {
    expect(lisbon.venues.filter((v) => v.category === 'lodging').length).toBeGreaterThanOrEqual(4);
    expect(lisbon.transit.length).toBeGreaterThanOrEqual(10);
    expect(lisbon.weather.monthly).toHaveLength(12);
  });
});

describe('upload validation rejects bad data with a clear message (spec 6.3)', () => {
  const cases = [
    ['a negative price', (d) => (d.venues[0].pricePerPerson = -3), 'venues.0.pricePerPerson', /positive/],
    ['a zero price', (d) => (d.venues[0].pricePerPerson = 0), 'venues.0.pricePerPerson', /positive/],
    ['a price as text', (d) => (d.venues[0].pricePerPerson = '22'), 'venues.0.pricePerPerson', /number/],
    ['a misspelt dietary tag', (d) => (d.venues[0].dietaryTags = ['vegeterian']), 'venues.0.dietaryTags.0', /must be one of/],
    ['latitude out of range', (d) => (d.venues[0].coordinates.lat = 120), 'venues.0.coordinates.lat', /between -90 and 90/],
    ['longitude out of range', (d) => (d.venues[0].coordinates.lng = -200), 'venues.0.coordinates.lng', /between -180 and 180/],
    ['swapped lat/lng (far from the city)', (d) => (d.venues[0].coordinates = { lat: -9.13, lng: 38.71 }), 'venues.0.coordinates', /km from the destination/],
    ['hour 25', (d) => (d.venues[0].hours.open = '25:00'), 'venues.0.hours.open', /HH:MM/],
    ['bad minutes', (d) => (d.venues[0].hours.close = '22:75'), 'venues.0.hours.close', /HH:MM/],
    ['open equal to close', (d) => (d.venues[0].hours = { open: '10:00', close: '10:00' }), 'venues.0.hours.close', /cannot be equal/],
    ['a duplicate venueId', (d) => (d.venues[1].venueId = d.venues[0].venueId), 'venues.1.venueId', /Duplicate/],
    ['an unknown category', (d) => (d.venues[0].category = 'spa'), 'venues.0.category', /must be one of/],
    ['an unexpected field', (d) => (d.venues[0].secret = 'x'), 'venues.0', /Unrecognized key/i],
    ['an empty venue list', (d) => (d.venues = []), 'venues', /at least one venue/],
    ['an unsupported currency', (d) => (d.destination.currency = 'EUR'), 'destination.currency', /INR, USD/],
    ['an impossible forecast date', (d) => (d.weather.daily[0].date = '2026-13-01'), 'weather.daily.0.date', /YYYY-MM-DD/],
  ];

  test.each(cases)('rejects %s', (_label, mutate, path, message) => {
    const data = clone();
    mutate(data);
    const result = validateDataset(data);
    expect(result.ok).toBe(false);
    const issue = result.errors.find((e) => e.path === path);
    expect(issue).toBeDefined();
    expect(issue.message).toMatch(message);
  });

  test('accepts venues open past midnight (close earlier than open)', () => {
    const data = clone();
    data.venues[0].hours = { open: '22:00', close: '03:00' };
    expect(validateDataset(data).ok).toBe(true);
  });
});

describe('ingestion and the admin upload endpoint', () => {
  let server;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('loading twice does not duplicate venues, and removed venues disappear', async () => {
    const first = await ingestDataset(lisbon);
    expect(first.inserted).toBe(lisbon.venues.length);
    const again = await ingestDataset(lisbon);
    expect(again.inserted).toBe(0);
    expect(await Venue.countDocuments({ destination: 'lisbon' })).toBe(lisbon.venues.length);

    const smaller = clone();
    smaller.venues = smaller.venues.slice(0, 5);
    const result = await ingestDataset(smaller);
    expect(result.removed).toBe(lisbon.venues.length - 5);
    expect(await Venue.countDocuments({ destination: 'lisbon' })).toBe(5);
    await ingestDataset(lisbon);
  });

  test('a venueId owned by another destination is refused', async () => {
    const porto = clone();
    porto.destination = { ...porto.destination, slug: 'porto', name: 'Porto, Portugal', center: { lat: 41.1496, lng: -8.611 } };
    porto.venues = [{ ...lisbon.venues[0], coordinates: { lat: 41.15, lng: -8.61 } }];
    await expect(ingestDataset(porto)).rejects.toMatchObject({ status: 400 });
  });

  test('admin upload returns a summary; invalid upload returns 400 with every problem listed', async () => {
    const admin = await registerUser(server.app, { role: 'admin' });
    const ok = await request(server.app).post('/api/v1/admin/datasets').set('Authorization', admin.auth).send(lisbon);
    expect(ok.status).toBe(201);
    expect(ok.body.summary).toMatchObject({ destination: 'lisbon', venues: lisbon.venues.length });

    const bad = clone();
    bad.venues[0].pricePerPerson = -1;
    bad.venues[2].dietaryTags = ['paleo'];
    const res = await request(server.app).post('/api/v1/admin/datasets').set('Authorization', admin.auth).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path)).toEqual(
      expect.arrayContaining(['venues.0.pricePerPerson', 'venues.2.dietaryTags.0']),
    );
    // Nothing was changed by the rejected upload.
    expect((await Venue.findById('v_lis_001')).pricePerPerson).toBe(22);
  });

  test('validate-only endpoint checks without saving', async () => {
    const admin = await registerUser(server.app, { role: 'admin' });
    const res = await request(server.app)
      .post('/api/v1/admin/datasets/validate')
      .set('Authorization', admin.auth)
      .send(lisbon);
    expect(res.body).toEqual({ valid: true, destination: 'lisbon', venues: lisbon.venues.length });
  });
});

describe('every destination file in server/data/destinations', () => {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
  const load = (f) => JSON.parse(readFileSync(`${DATA_DIR}/${f}`, 'utf8'));

  test('the app ships only Indian destinations (Lisbon is a test fixture)', () => {
    expect(files).toEqual(['delhi.json', 'goa.json', 'jaipur.json', 'kochi.json', 'mumbai.json']);
  });

  test.each(files)('%s is priced in rupees and every venue has a credited Wikimedia photo', (f) => {
    const data = load(f);
    expect(data.destination.currency).toBe('INR');
    expect(data.destination.image?.url).toMatch(/^https:\/\/(upload|thumb)\.wikimedia\.org\//);
    for (const v of data.venues) {
      expect(v.image).toMatchObject({ url: expect.stringMatching(/^https:\/\/(upload|thumb)\.wikimedia\.org\//), credit: expect.any(String), license: expect.any(String) });
      expect(Number.isInteger(v.pricePerPerson)).toBe(true); // whole rupees
    }
  });

  test.each(files)('%s passes validation, its slug matches the file name, and it has every venue category', (f) => {
    const data = load(f);
    const result = validateDataset(data);
    expect(result.errors).toBeUndefined();
    expect(data.destination.slug).toBe(f.replace(/\.json$/, ''));
    for (const c of VENUE_CATEGORIES) expect(data.venues.some((v) => v.category === c)).toBe(true);
    for (const tag of ['vegetarian', 'vegan', 'halal', 'gluten-free']) {
      expect(data.venues.some((v) => FOOD_CATEGORIES.includes(v.category) && v.dietaryTags.includes(tag))).toBe(true);
    }
    expect(data.weather.monthly).toHaveLength(12);
  });

  // Found on the live site: a plain "vegetarian dinner under $20 at 8 PM"
  // returned no match in Delhi and Goa. Every city must be able to answer it
  // (now in rupees: under ₹1,500).
  test.each(files)('%s has a vegetarian dinner under ₹1,500 open 20:00-21:30', (f) => {
    const ok = load(f).venues.filter((v) => v.category === 'dinner' && v.dietaryTags.includes('vegetarian') &&
      v.pricePerPerson <= 1500 && isOpenFor(v.hours, { start: 20 * 60, end: 21 * 60 + 30 }));
    expect(ok.length).toBeGreaterThanOrEqual(1);
  });

  test('venue ids are unique across all destinations', () => {
    const ids = files.flatMap((f) => load(f).venues.map((v) => v.venueId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
