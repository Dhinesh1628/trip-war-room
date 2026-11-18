import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { DATA_DIR } from '../src/venues/seedData.js';
import {
  filterCandidates,
  rankCandidates,
  isOpenFor,
  openWindow,
  toMinutes,
  WEIGHTS,
} from '../src/concierge/constraints.js';
import { DIETARY_TAGS, FOOD_CATEGORIES } from '../src/venues/vocabulary.js';

// Spec 6.2 acceptance: "every AI Concierge suggestion satisfies all active
// constraints ... automated test asserting 100% constraint compliance across
// at least 20 simulated suggestion requests".
//
// The checker below is written separately from src/concierge/constraints.js
// on purpose, so the matcher is not marked against its own code.

let venues;

beforeAll(async () => {
  const data = JSON.parse(await readFile(`${DATA_DIR}/lisbon.json`, 'utf8'));
  venues = data.venues;
});

// ---- independent reference implementation ---------------------------------

function haversineKm(a, b) {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function minutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Is the venue open for every minute of [start, end)?
function referenceOpen(hours, start, end) {
  if (hours.open === '00:00' && hours.close === '23:59') return true;
  const o = minutes(hours.open);
  const c = minutes(hours.close);
  const openAt = (t) => {
    const m = ((t % 1440) + 1440) % 1440;
    return c > o ? m >= o && m < c : m >= o || m < c;
  };
  for (let t = start; t < end; t += 1) if (!openAt(t)) return false;
  // The venue must not close before the slot ends (end itself may equal close).
  return true;
}

function violations(venue, req) {
  const v = [];
  if (req.maxPricePerPerson != null && venue.pricePerPerson > req.maxPricePerPerson) v.push('budget');
  if (req.dietaryTags.length && FOOD_CATEGORIES.includes(venue.category)) {
    if (!req.dietaryTags.every((t) => venue.dietaryTags.includes(t))) v.push('dietary');
  }
  if (req.slot && !referenceOpen(venue.hours, req.slot.start, req.slot.end)) v.push('hours');
  if (req.anchor && haversineKm(req.anchor.coordinates, venue.coordinates) > req.radiusKm) v.push('proximity');
  return v;
}

// ---- simulated requests -------------------------------------------------------

// Anchors are real pinned-event locations from the dataset.
const ANCHORS = {
  alfamaTour: { coordinates: { lat: 38.7118, lng: -9.1296 } },
  belemMonastery: { coordinates: { lat: 38.6979, lng: -9.2068 } },
  oceanarium: { coordinates: { lat: 38.7635, lng: -9.0938 } },
  bairroAlto: { coordinates: { lat: 38.7135, lng: -9.145 } },
};

function simulatedRequests() {
  const requests = [];
  const categories = ['dinner', 'lunch', 'breakfast', 'cafe', 'bar', 'lodging', 'museum', 'tour', null];
  const prices = [null, 10, 20, 25, 40, 100];
  const diets = [[], ['vegetarian'], ['vegan'], ['halal'], ['gluten-free', 'dairy-free'], ['kosher'], ['vegan', 'nut-free']];
  const slots = [null, { start: 8 * 60, end: 9 * 60 }, { start: 12 * 60 + 30, end: 13 * 60 + 30 }, { start: 19 * 60 + 30, end: 21 * 60 }, { start: 23 * 60 + 30, end: 25 * 60 }];
  const anchors = [null, 'alfamaTour', 'belemMonastery', 'oceanarium', 'bairroAlto'];
  const radii = [0.5, 1, 2, 5];
  let i = 0;
  // Every category x price x diet combination; slot, anchor and radius are
  // walked deterministically so the requests differ along every dimension.
  for (const category of categories) {
    for (const price of prices) {
      for (const dietaryTags of diets) {
        const slot = slots[(i * 3) % slots.length];
        const anchorKey = anchors[(i * 7) % anchors.length];
        const radiusKm = radii[(i * 5) % radii.length];
        requests.push({
          category,
          maxPricePerPerson: price,
          dietaryTags,
          slot,
          anchor: anchorKey ? ANCHORS[anchorKey] : null,
          radiusKm,
          label: `#${i} ${category ?? 'any'} <=$${price ?? '-'} [${dietaryTags}] ${slot ? `${slot.start}-${slot.end}` : 'any time'} ${anchorKey ?? 'no anchor'} ${radiusKm}km`,
        });
        i += 1;
      }
    }
  }
  // Plus the spec's own example: dinner near the 5 PM Alfama tour, under $25.
  requests.push({
    category: 'dinner',
    maxPricePerPerson: 25,
    dietaryTags: ['vegetarian'],
    slot: { start: 19 * 60 + 30, end: 21 * 60 },
    anchor: ANCHORS.alfamaTour,
    radiusKm: 2,
    label: 'spec example',
  });
  return requests;
}

describe('100% constraint compliance (spec 6.2 acceptance)', () => {
  const requests = simulatedRequests();

  test(`there are at least 20 simulated requests (actually ${requests.length})`, () => {
    expect(requests.length).toBeGreaterThanOrEqual(20);
  });

  test('every suggestion and every ranked candidate satisfies every active constraint', () => {
    let withSuggestion = 0;
    for (const req of requests) {
      const { valid } = filterCandidates(venues, req);
      const ranked = rankCandidates(valid, req);
      if (ranked.length) withSuggestion += 1;
      for (const { venue } of ranked) {
        const v = violations(venue, req);
        if (v.length) throw new Error(`${req.label}: suggested ${venue.venueId} breaks ${v.join(', ')}`);
        if (req.category) expect(venue.category).toBe(req.category);
      }
    }
    // Make sure the test actually exercised suggestions, not just empty results.
    // (Many combinations, e.g. a kosher breakfast under $10, rightly have none.)
    console.log(`compliance: ${requests.length} requests, ${withSuggestion} with suggestions, 0 violations`);
    expect(withSuggestion).toBeGreaterThanOrEqual(50);
  });

  test('every rejected venue really breaks at least one rule (no good venue is thrown away)', () => {
    for (const req of requests) {
      const { rejected } = filterCandidates(venues, req);
      for (const { venue, failures } of rejected) {
        const v = violations(venue, req);
        expect(v.sort()).toEqual(Object.keys(failures).sort());
      }
    }
  });

  test('the spec example finds a vegetarian dinner under $25 within 2 km of the tour', () => {
    const req = requests.at(-1);
    const ranked = rankCandidates(filterCandidates(venues, req).valid, req);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].venue.pricePerPerson).toBeLessThanOrEqual(25);
    expect(ranked[0].venue.dietaryTags).toContain('vegetarian');
  });

  test.each(DIETARY_TAGS)('a %s request only returns food venues carrying that tag', (tag) => {
    const req = { category: null, maxPricePerPerson: null, dietaryTags: [tag], slot: null, anchor: null, radiusKm: 2 };
    const { valid } = filterCandidates(venues, req);
    for (const v of valid.filter((x) => FOOD_CATEGORIES.includes(x.category))) expect(v.dietaryTags).toContain(tag);
    expect(valid.some((x) => FOOD_CATEGORIES.includes(x.category))).toBe(true);
  });
});

describe('opening hours', () => {
  const late = { open: '22:00', close: '03:00' };
  const day = { open: '11:00', close: '22:00' };

  test.each([
    [day, 19 * 60 + 30, 21 * 60, true],
    [day, 21 * 60, 22 * 60, true], // ends exactly at closing
    [day, 21 * 60, 22 * 60 + 1, false],
    [day, 10 * 60 + 59, 12 * 60, false],
    [late, 23 * 60, 24 * 60 + 30, true], // across midnight
    [late, 30, 90, true], // 00:30-01:30, after midnight
    [late, 2 * 60 + 30, 3 * 60 + 30, false],
    [late, 20 * 60, 23 * 60, false],
    [{ open: '00:00', close: '23:59' }, 23 * 60, 24 * 60 + 30, true], // always open
  ])('%j open for %i-%i: %s', (hours, start, end, expected) => {
    expect(isOpenFor(hours, { start, end })).toBe(expected);
    expect(referenceOpen(hours, start, end)).toBe(expected);
  });

  test('a midnight close counts as open past midnight', () => {
    expect(openWindow({ open: '10:00', close: '00:00' })).toEqual({ open: 600, close: 1440 });
    expect(toMinutes('19:30')).toBe(1170);
  });
});

describe('ranking: 40% proximity, 30% rating/popularity, 30% budget headroom', () => {
  const base = {
    category: 'dinner',
    dietaryTags: [],
    hours: { open: '11:00', close: '23:00' },
    rating: 4,
    reviewCount: 100,
    pricePerPerson: 10,
  };
  const anchor = { coordinates: { lat: 38.71, lng: -9.13 } };
  const at = (km) => ({ lat: 38.71 + km / 111.32, lng: -9.13 });
  const c = { maxPricePerPerson: 20, anchor, radiusKm: 2 };

  test('the weights add up to 1', () => {
    expect(WEIGHTS.proximity + WEIGHTS.rating + WEIGHTS.headroom).toBeCloseTo(1, 10);
  });

  test('closer wins when everything else is equal', () => {
    const ranked = rankCandidates(
      [
        { ...base, venueId: 'v_far', coordinates: at(1.5) },
        { ...base, venueId: 'v_near', coordinates: at(0.2) },
      ],
      c,
    );
    expect(ranked.map((r) => r.venue.venueId)).toEqual(['v_near', 'v_far']);
  });

  test('more margin under the ceiling wins when everything else is equal', () => {
    const ranked = rankCandidates(
      [
        { ...base, venueId: 'v_19', pricePerPerson: 19, coordinates: at(0.5) },
        { ...base, venueId: 'v_8', pricePerPerson: 8, coordinates: at(0.5) },
      ],
      c,
    );
    expect(ranked[0].venue.venueId).toBe('v_8');
    expect(ranked[0].scores.headroom).toBeCloseTo(0.6, 3);
  });

  test('the score is exactly the weighted sum of its parts', () => {
    const [r] = rankCandidates([{ ...base, venueId: 'v_x', coordinates: at(1) }], c);
    const expected = 0.4 * r.scores.proximity + 0.3 * r.scores.rating + 0.3 * r.scores.headroom;
    expect(r.score).toBeCloseTo(expected, 2);
    expect(r.scores.proximity).toBeCloseTo(0.5, 2);
    expect(r.scores.headroom).toBeCloseTo(0.5, 3);
  });

  test('ties are broken by venue id, so ranking is deterministic', () => {
    const twins = ['v_b', 'v_a', 'v_c'].map((venueId) => ({ ...base, venueId, coordinates: at(0.5) }));
    expect(rankCandidates(twins, c).map((r) => r.venue.venueId)).toEqual(['v_a', 'v_b', 'v_c']);
  });

  test('walking minutes come from distance', () => {
    const [r] = rankCandidates([{ ...base, venueId: 'v_x', coordinates: at(0.4) }], c);
    expect(r.distanceKm).toBeCloseTo(0.4, 2);
    expect(r.walkMinutes).toBe(6); // 0.4 km x 1.25 / 4.8 km/h = 6.25 min
  });
});

// The same compliance check for every other destination file (Delhi, Mumbai,
// Jaipur, Goa, Kochi, ...). Anchors are each city's own tours and landmarks.
describe('100% constraint compliance in every destination', () => {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && f !== 'lisbon.json').sort();

  test('there are other destinations to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  test.each(files)('%s: every suggestion satisfies every active rule, and every rejection is justified', (file) => {
    const cityVenues = JSON.parse(readFileSync(`${DATA_DIR}/${file}`, 'utf8')).venues;
    const anchors = cityVenues.filter((v) => ['tour', 'attraction', 'museum'].includes(v.category));
    const base = simulatedRequests().slice(0, -1); // the matrix, without the Lisbon-only spec example
    let withSuggestion = 0;
    base.forEach((req, i) => {
      const r = { ...req, anchor: req.anchor ? anchors[i % anchors.length] : null };
      const { valid, rejected } = filterCandidates(cityVenues, r);
      const ranked = rankCandidates(valid, r);
      if (ranked.length) withSuggestion += 1;
      for (const { venue } of ranked) {
        const v = violations(venue, r);
        if (v.length) throw new Error(`${file} ${req.label}: suggested ${venue.venueId} breaks ${v.join(', ')}`);
        if (r.category) expect(venue.category).toBe(r.category);
      }
      for (const { venue, failures } of rejected) expect(violations(venue, r).sort()).toEqual(Object.keys(failures).sort());
    });
    expect(withSuggestion).toBeGreaterThanOrEqual(30);
  });
});
