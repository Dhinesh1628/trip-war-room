import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { startTestServer, registerUser } from './helpers.js';
import { distanceKm, boundingBox, parseLatLng } from '../src/venues/geo.js';
import { DATA_DIR } from '../src/venues/seedData.js';
import { FIXTURE_DIR } from './fixtures.js';

let server;
let app;
let auth;
let lisbon;

// Meeting point of the Alfama walking tour (v_lis_025): the "5 PM tour" anchor.
const TOUR = { lat: 38.7118, lng: -9.1296 };

beforeAll(async () => {
  server = await startTestServer({ seed: true });
  app = server.app;
  auth = (await registerUser(app)).auth;
  lisbon = JSON.parse(await readFile(`${FIXTURE_DIR}/lisbon.json`, 'utf8'));
});

afterAll(async () => {
  await server.stop();
});

describe('geo helpers', () => {
  test('haversine distance matches a hand calculation (Baixa to Belém tower is about 7.2 km)', () => {
    // dLat 0.0194° ≈ 2.16 km, dLng 0.0794° × 86.9 km/° ≈ 6.90 km → √(2.16² + 6.90²) ≈ 7.23 km
    const km = distanceKm({ lat: 38.711, lng: -9.1366 }, { lat: 38.6916, lng: -9.216 });
    expect(km).toBeGreaterThan(7.1);
    expect(km).toBeLessThan(7.35);
    expect(distanceKm(TOUR, TOUR)).toBe(0);
  });

  test('the bounding box contains every point within the radius', () => {
    const box = boundingBox(TOUR, 2);
    for (let angle = 0; angle < 360; angle += 15) {
      const rad = (angle * Math.PI) / 180;
      const p = {
        lat: TOUR.lat + (1.99 / 111.32) * Math.cos(rad),
        lng: TOUR.lng + (1.99 / (111.32 * Math.cos((TOUR.lat * Math.PI) / 180))) * Math.sin(rad),
      };
      expect(p.lat).toBeGreaterThanOrEqual(box.minLat);
      expect(p.lat).toBeLessThanOrEqual(box.maxLat);
      expect(p.lng).toBeGreaterThanOrEqual(box.minLng);
      expect(p.lng).toBeLessThanOrEqual(box.maxLng);
    }
  });

  test('parseLatLng accepts "lat,lng" and rejects junk', () => {
    expect(parseLatLng('38.71, -9.13')).toEqual({ lat: 38.71, lng: -9.13 });
    expect(parseLatLng('91,0')).toBeNull();
    expect(parseLatLng('0,181')).toBeNull();
    expect(parseLatLng('abc,def')).toBeNull();
    expect(parseLatLng('38.71')).toBeNull();
    expect(parseLatLng('38.71,')).toBeNull();
  });
});

describe('destinations', () => {
  test('lists seeded destinations with venue counts', async () => {
    const res = await request(app).get('/api/v1/destinations').set('Authorization', auth);
    expect(res.status).toBe(200);
    const l = res.body.destinations.find((d) => d.slug === 'lisbon');
    expect(l).toMatchObject({ name: 'Lisbon, Portugal', venueCount: lisbon.venues.length });
  });

  test('destination detail includes transit and weather', async () => {
    const res = await request(app).get('/api/v1/destinations/lisbon').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.transit.length).toBeGreaterThan(5);
    expect(res.body.weather.monthly).toHaveLength(12);
    expect(res.body.weather.daily.length).toBeGreaterThan(0);
  });

  test('unknown destination gives 404', async () => {
    const res = await request(app).get('/api/v1/destinations/atlantis/venues').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  test('catalog requires authentication', async () => {
    expect((await request(app).get('/api/v1/destinations/lisbon/venues')).status).toBe(401);
  });
});

describe('GET /destinations/{destination}/venues (spec 7.3.2)', () => {
  test('returns every venue in the spec shape', async () => {
    const res = await request(app)
      .get(`/api/v1/destinations/${encodeURIComponent('Lisbon, Portugal')}/venues`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe('Lisbon, Portugal');
    expect(res.body.venues).toHaveLength(lisbon.venues.length);
    expect(res.body.venues[0]).toEqual(
      expect.objectContaining({
        venueId: expect.stringMatching(/^v_/),
        name: expect.any(String),
        category: expect.any(String),
        pricePerPerson: expect.any(Number),
        dietaryTags: expect.any(Array),
        hours: { open: expect.any(String), close: expect.any(String) },
        coordinates: { lat: expect.any(Number), lng: expect.any(Number) },
      }),
    );
  });

  test('near + radiusKm returns exactly the venues a brute-force check finds, nearest first', async () => {
    for (const radiusKm of [0.3, 1, 2, 5]) {
      const res = await request(app)
        .get(`/api/v1/destinations/lisbon/venues?near=${TOUR.lat},${TOUR.lng}&radiusKm=${radiusKm}`)
        .set('Authorization', auth);
      expect(res.status).toBe(200);

      const expected = lisbon.venues
        .filter((v) => distanceKm(TOUR, v.coordinates) <= radiusKm)
        .map((v) => v.venueId)
        .sort();
      expect(res.body.venues.map((v) => v.venueId).sort()).toEqual(expected);

      const distances = res.body.venues.map((v) => v.distanceKm);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
      expect(distances.every((d) => d <= radiusKm)).toBe(true);
    }
  });

  test('radius defaults to 2 km when only near is given', async () => {
    const res = await request(app)
      .get(`/api/v1/destinations/lisbon/venues?near=${TOUR.lat},${TOUR.lng}`)
      .set('Authorization', auth);
    expect(res.body.radiusKm).toBe(2);
    expect(res.body.venues.every((v) => v.distanceKm <= 2)).toBe(true);
  });

  test('category filter', async () => {
    const res = await request(app).get('/api/v1/destinations/lisbon/venues?category=lodging').set('Authorization', auth);
    expect(res.body.venues.length).toBeGreaterThan(0);
    expect(res.body.venues.every((v) => v.category === 'lodging')).toBe(true);
  });

  test.each([
    ['near=abc', 'near'],
    ['near=38.7,-9.1&radiusKm=0', 'radiusKm'],
    ['near=38.7,-9.1&radiusKm=500', 'radiusKm'],
    ['category=spaceship', 'category'],
    ['unknown=1', ''],
  ])('rejects bad query %s', async (qs) => {
    const res = await request(app).get(`/api/v1/destinations/lisbon/venues?${qs}`).set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  test('single venue detail', async () => {
    const res = await request(app).get('/api/v1/destinations/lisbon/venues/v_lis_001').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.venue.name).toBe('Taberna da Rua');
    const missing = await request(app).get('/api/v1/destinations/lisbon/venues/v_nope').set('Authorization', auth);
    expect(missing.status).toBe(404);
  });
});
