import { readFile } from 'node:fs/promises';
import { DATA_DIR } from '../src/venues/seedData.js';
import { FIXTURE_DIR } from './fixtures.js';
import { buildModel, scoreForUser, recommendForGroup, features } from '../src/recs/recommender.js';
import { generateDataset } from '../src/recs/generate.js';
import { precisionAtK } from '../src/recs/evaluate.js';

let venues;
beforeAll(async () => {
  venues = JSON.parse(await readFile(`${FIXTURE_DIR}/lisbon.json`, 'utf8')).venues;
});

const like = (userId, venueId, extra = {}) => ({ userId, venueId, liked: true, weight: 1, coTraveledWith: [], ...extra });
const dislike = (userId, venueId) => ({ userId, venueId, liked: false, weight: 1, coTraveledWith: [] });
const topIds = (scores, n, exclude = []) =>
  [...scores.entries()]
    .filter(([id]) => !exclude.includes(id))
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([id]) => id);

describe('content-based part', () => {
  test('venue features include category, price band, area, setting and dietary tags', () => {
    const f = features(venues.find((v) => v.venueId === 'v_lis_002')); // Horta Verde, $18 vegan dinner
    expect([...f.keys()].sort()).toEqual(
      ['area:Mouraria', 'cat:dinner', 'diet:dairy-free', 'diet:gluten-free', 'diet:vegan', 'diet:vegetarian', 'indoor', 'price:moderate'].sort(),
    );
  });

  test('someone who liked museums is recommended more museums', () => {
    const model = buildModel([like('me', 'v_lis_028'), like('me', 'v_lis_030')], venues);
    const top = topIds(scoreForUser(model, 'me'), 3, ['v_lis_028', 'v_lis_030']);
    expect(top).toContain('v_lis_036'); // the other museum
  });

  test('dislikes push similar venues down', () => {
    const neutral = buildModel([like('me', 'v_lis_028')], venues);
    const withDislike = buildModel([like('me', 'v_lis_028'), dislike('me', 'v_lis_024')], venues);
    const bar = 'v_lis_023';
    expect(scoreForUser(withDislike, 'me').get(bar).score).toBeLessThan(scoreForUser(neutral, 'me').get(bar).score);
  });

  test('with no history, the ranking falls back to popularity', () => {
    const model = buildModel([], venues);
    const s = scoreForUser(model, 'new');
    expect([...s.values()][0].why).toBe('popular with visitors');
    // popularity = 0.8 x rating/5 + 0.2 x log(1+reviews)/log(1+max reviews)
    // Oceanário:        0.8 x 0.94 + 0.2 x 1.000 = 0.952  (4.7 stars, 7,600 reviews = the most)
    // Monastery:        0.8 x 0.94 + 0.2 x 0.951 = 0.942  (4.7 stars, 4,900 reviews)
    // Palácio Chiado:   0.8 x 0.98 + 0.2 x 0.759 = 0.936  (4.9 stars, 880 reviews)
    expect(topIds(s, 3)).toEqual(['v_lis_031', 'v_lis_030', 'v_lis_041']);
  });
});

describe('collaborative part and group affinity', () => {
  // A and B share three likes; B also liked the sailing tour. C is unrelated.
  const base = [
    ...['v_lis_001', 'v_lis_017', 'v_lis_025'].map((v) => like('A', v)),
    ...['v_lis_001', 'v_lis_017', 'v_lis_025', 'v_lis_034'].map((v) => like('B', v)),
    ...['v_lis_041', 'v_lis_007', 'v_lis_031'].map((v) => like('C', v)),
  ];

  test("what a similar traveller liked is recommended, and the reason says so", () => {
    const s = scoreForUser(buildModel(base, venues), 'A');
    expect(topIds(s, 1, ['v_lis_001', 'v_lis_017', 'v_lis_025'])).toEqual(['v_lis_034']);
    expect(s.get('v_lis_034').why).toBe('liked by travellers with similar taste');
  });

  test('a co-traveller counts more than a stranger with the same overlap', () => {
    // D and E have identical overlap with A; only E has travelled with A.
    const rows = [
      ...['v_lis_001', 'v_lis_017', 'v_lis_025'].map((v) => like('A', v, { coTraveledWith: ['E'] })),
      ...['v_lis_001', 'v_lis_017', 'v_lis_033'].map((v) => like('D', v)), // D also liked LX Factory
      ...['v_lis_001', 'v_lis_017', 'v_lis_032'].map((v) => like('E', v, { coTraveledWith: ['A'] })), // E liked the fado night
    ];
    const s = scoreForUser(buildModel(rows, venues), 'A');
    expect(s.get('v_lis_032').collab).toBeGreaterThan(s.get('v_lis_033').collab);
    expect(s.get('v_lis_032').why).toBe('liked by people you have travelled with');
  });

  test('group recommendations respect dietary needs and skip what is on the board', () => {
    const model = buildModel(base, venues);
    const recs = recommendForGroup(model, ['A', 'B'], { exclude: ['v_lis_034'], dietaryTags: ['vegan'], limit: 10 });
    expect(recs.map((r) => r.venueId)).not.toContain('v_lis_034');
    for (const r of recs.filter((x) => ['breakfast', 'lunch', 'dinner', 'cafe', 'bar'].includes(x.category))) {
      expect(r.dietaryTags).toContain('vegan');
    }
    expect(recs[0]).toEqual(expect.objectContaining({ venueId: expect.any(String), score: expect.any(Number), why: expect.any(String) }));
  });
});

describe('offline evaluation (spec 1.3: Precision@5 >= 0.6)', () => {
  test('the hybrid model meets the target on the generated held-out set', () => {
    const data = generateDataset(venues, { seed: 2026 });
    const hybrid = precisionAtK(venues, data);
    const popularity = precisionAtK(venues, data, { scorer: 'popularity' });
    expect(hybrid.users).toBeGreaterThanOrEqual(50);
    expect(hybrid.precisionAt5).toBeGreaterThanOrEqual(0.6);
    // And it clearly beats a plain popularity ranking.
    expect(hybrid.precisionAt5).toBeGreaterThan(popularity.precisionAt5 + 0.3);
  });

  test('the generated dataset is reproducible', () => {
    const a = generateDataset(venues, { seed: 5 });
    const b = generateDataset(venues, { seed: 5 });
    expect(a.train).toEqual(b.train);
    expect([...a.test.entries()].map(([k, v]) => [k, [...v]])).toEqual([...b.test.entries()].map(([k, v]) => [k, [...v]]));
  });
});
