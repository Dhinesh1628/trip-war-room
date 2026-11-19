import request from 'supertest';
import { startTestServer, registerUser, createTrip } from './helpers.js';
import { routedWalkMinutes, walkingMeters } from '../src/venues/walking.js';
import { loadCatalogForTests } from './fixtures.js';

// Traveller reviews, walking routes from OpenStreetMap footpaths, and the
// self-hosted photo records.

let server;
let app;
let u;
beforeAll(async () => {
  server = await startTestServer({ seed: true });
  app = server.app;
  u = await registerUser(app);
});
afterAll(async () => {
  await server.stop();
});

const reviews = (who, id = 'v_jai_006') => request(app).put(`/api/v1/destinations/jaipur/venues/${id}/reviews`).set('Authorization', who.auth);

describe('reviews', () => {
  test('write, read with summary, replace (one per traveller), delete', async () => {
    const other = await registerUser(app, { displayName: 'Kabir' });
    expect((await reviews(u).send({ rating: 4, text: 'Good dal, great view' })).status).toBe(200);
    expect((await reviews(other).send({ rating: 5 })).status).toBe(200);

    const list = await request(app).get('/api/v1/destinations/jaipur/venues/v_jai_006/reviews').set('Authorization', u.auth);
    expect(list.body.summary).toEqual({ count: 2, average: 4.5 });
    expect(list.body.reviews.map((r) => r.displayName).sort()).toEqual(['Kabir', u.user.displayName].sort());
    expect(list.body.mine).toMatchObject({ rating: 4, text: 'Good dal, great view' });

    await reviews(u).send({ rating: 2, text: 'Changed my mind' });
    const again = await request(app).get('/api/v1/destinations/jaipur/venues/v_jai_006/reviews').set('Authorization', u.auth);
    expect(again.body.summary).toEqual({ count: 2, average: 3.5 });

    const venues = await request(app).get('/api/v1/destinations/jaipur/venues').set('Authorization', u.auth);
    expect(venues.body.venues.find((v) => v.venueId === 'v_jai_006').travellerReviews).toEqual({ count: 2, average: 3.5 });
    expect(venues.body.venues.find((v) => v.venueId === 'v_jai_012').travellerReviews).toEqual({ count: 0, average: null });

    expect((await request(app).delete('/api/v1/destinations/jaipur/venues/v_jai_006/reviews').set('Authorization', u.auth)).status).toBe(204);
    expect((await request(app).delete('/api/v1/destinations/jaipur/venues/v_jai_006/reviews').set('Authorization', u.auth)).status).toBe(404);
  });

  test('review text is cleaned of HTML', async () => {
    await reviews(u, 'v_jai_012').send({ rating: 5, text: '<script>alert(1)</script>Beautiful <b>windows</b>' });
    const list = await request(app).get('/api/v1/destinations/jaipur/venues/v_jai_012/reviews').set('Authorization', u.auth);
    expect(list.body.mine.text).toBe('alert(1)Beautiful windows');
  });

  test.each([
    [{ rating: 0 }],
    [{ rating: 6 }],
    [{ rating: 4.5 }],
    [{ rating: 4, text: 'x'.repeat(1001) }],
    [{ rating: 4, extra: true }],
    [{}],
  ])('invalid review %j is refused', async (body) => {
    expect((await reviews(u).send(body)).status).toBe(400);
  });

  test('unknown venue is 404; signed out is 401', async () => {
    expect((await reviews(u, 'v_nope_001').send({ rating: 3 })).status).toBe(404);
    expect((await request(app).get('/api/v1/destinations/jaipur/venues/v_jai_006/reviews')).status).toBe(401);
  });

  test('an admin can delete anyone\'s review; others cannot', async () => {
    const admin = await registerUser(app, { role: 'admin' });
    const writer = await registerUser(app);
    await reviews(writer, 'v_jai_010').send({ rating: 1, text: 'spam' });
    const asOther = await request(app).delete(`/api/v1/destinations/jaipur/venues/v_jai_010/reviews?userId=${writer.user.id}`).set('Authorization', u.auth);
    expect(asOther.status).toBe(404); // a non-admin's userId is ignored: they have no review there
    const asAdmin = await request(app).delete(`/api/v1/destinations/jaipur/venues/v_jai_010/reviews?userId=${writer.user.id}`).set('Authorization', admin.auth);
    expect(asAdmin.status).toBe(204);
  });
});

describe('walking routes (OpenStreetMap footpaths)', () => {
  beforeAll(async () => {
    await loadCatalogForTests();
  });

  test('the Indian datasets carry real footpath distances', () => {
    // Hawa Mahal to Haveli Rooftop Dining (across the road) and to Amber Fort (11 km).
    expect(walkingMeters('v_jai_012', 'v_jai_006')).toBeGreaterThan(50);
    expect(walkingMeters('v_jai_012', 'v_jai_006')).toBeLessThan(600);
    expect(walkingMeters('v_jai_012', 'v_jai_010')).toBeGreaterThan(5000);
    expect(routedWalkMinutes('v_jai_012', 'v_jai_006')).toBeGreaterThanOrEqual(1);
    expect(walkingMeters('v_jai_012', 'v_goa_001')).toBeNull(); // different cities
    expect(walkingMeters('v_lis_001', 'v_lis_002')).toBeNull(); // the fixture has no routes
  });

  test('a place page lists the three closest places on foot', async () => {
    const r = await request(app).get('/api/v1/destinations/jaipur/venues/v_jai_012').set('Authorization', u.auth);
    expect(r.body.nearby).toHaveLength(3);
    expect(r.body.nearby.every((n) => n.routed && n.walkMinutes >= 1)).toBe(true);
    const mins = r.body.nearby.map((n) => n.walkMinutes);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });

  test('the Concierge reports the footpath walking time from the anchor', async () => {
    const trip = await createTrip(app, u, { destination: 'jaipur', startDate: '2099-02-01', endDate: '2099-02-02', totalBudget: 40000 });
    const { joinRoom } = await import('./socketHelpers.js');
    const c = await joinRoom(server.url, { token: u.token, tripId: trip.tripId });
    await c.send('trip.board.pin', { venueId: 'v_jai_012', dayIndex: 0, startTime: '10:00', endTime: '11:30' });
    const ans = await request(app).post(`/api/v1/trips/${trip.tripId}/ai/ask`).set('Authorization', u.auth).send({ question: 'veg lunch near our hawa mahal visit' });
    const best = ans.body.sources.find((s) => s.venueId === ans.body.suggestedVenueId);
    expect(best.walkMinutes).toBe(routedWalkMinutes('v_jai_012', best.venueId));
    c.close();
  });
});

describe('photos', () => {
  test('venues and cities point at self-hosted photos with credits; representative ones are marked', async () => {
    const list = await request(app).get('/api/v1/destinations/jaipur/venues').set('Authorization', u.auth);
    for (const v of list.body.venues) {
      expect(v.image.url).toMatch(/^\/photos\/[a-z0-9-]+\.jpg$/);
      expect(v.image.source).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(typeof v.image.representative).toBe('boolean');
    }
    expect(list.body.venues.find((v) => v.name === 'Hawa Mahal').image.representative).toBe(false);
    expect(list.body.venues.find((v) => v.name === 'Dal Baati House').image.representative).toBe(true);
    const dests = await request(app).get('/api/v1/destinations').set('Authorization', u.auth);
    expect(dests.body.destinations.filter((d) => d.currency === 'INR').every((d) => /^\/photos\//.test(d.image.url))).toBe(true);
  });
});
