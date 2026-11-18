import { splitCents, itemCost, computeBudget, attendeesOf, toCents } from '../src/board/budgetEngine.js';

// Spec 1.3 / 13: budget math is a hard-accuracy requirement (100%).
// Every expected number below was worked out by hand.

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

describe('splitting an amount', () => {
  test('even split with no remainder', () => {
    expect(Object.fromEntries(splitCents(9000, ['a', 'b', 'c']))).toEqual({ a: 3000, b: 3000, c: 3000 });
  });

  test('$100.00 three ways: the extra cent goes to the lowest id', () => {
    // 10000 / 3 = 3333 r1 each; one leftover cent -> 'a'
    expect(Object.fromEntries(splitCents(10000, ['c', 'b', 'a']))).toEqual({ a: 3334, b: 3333, c: 3333 });
  });

  test('$0.05 four ways', () => {
    expect(Object.fromEntries(splitCents(5, ['a', 'b', 'c', 'd']))).toEqual({ a: 2, b: 1, c: 1, d: 1 });
  });

  test('weighted 2:1:1 of $256.00 (a bigger room)', () => {
    // 25600 * 2/4 = 12800, 25600 * 1/4 = 6400
    expect(Object.fromEntries(splitCents(25600, ['a', 'b', 'c'], { a: 2, b: 1, c: 1 }))).toEqual({ a: 12800, b: 6400, c: 6400 });
  });

  test('weighted 3:2:2 of $100.00: leftover cents go to the largest remainders', () => {
    // a: 10000*3/7 = 4285 r5, b and c: 10000*2/7 = 2857 r1 each; 4285+2857+2857 = 9999, 1 cent left
    // largest remainder is a (5 > 1) -> a gets it
    expect(Object.fromEntries(splitCents(10000, ['a', 'b', 'c'], { a: 3, b: 2, c: 2 }))).toEqual({ a: 4286, b: 2857, c: 2857 });
  });

  test('a zero weight pays nothing', () => {
    expect(Object.fromEntries(splitCents(1001, ['a', 'b', 'c'], { a: 1, b: 0, c: 1 }))).toEqual({ a: 501, b: 0, c: 500 });
  });

  test.each([
    [() => splitCents(-1, ['a'])],
    [() => splitCents(10.5, ['a'])],
    [() => splitCents(100, ['a', 'b'], { a: 1.5, b: 1 })],
    [() => splitCents(100, ['a', 'b'], { a: 0, b: 0 })],
  ])('bad input is refused', (fn) => {
    expect(fn).toThrow();
  });

  test('2,000 random splits always add up exactly and differ by at most one cent from the ideal', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 2000; i += 1) {
      const n = 1 + Math.floor(rand() * 8);
      const ids = Array.from({ length: n }, (_, k) => `u${k}`);
      const total = Math.floor(rand() * 1_000_000);
      const weighted = rand() < 0.5;
      const weights = weighted ? Object.fromEntries(ids.map((id) => [id, 1 + Math.floor(rand() * 5)])) : null;
      const shares = splitCents(total, ids, weights);
      expect(sum(shares)).toBe(total);
      const W = weighted ? Object.values(weights).reduce((a, b) => a + b, 0) : n;
      for (const id of ids) {
        const ideal = (total * (weighted ? weights[id] : 1)) / W;
        expect(Math.abs(shares.get(id) - ideal)).toBeLessThan(1);
      }
    }
  });
});

describe('items and trips', () => {
  const people = ['ana', 'ben', 'cai', 'dev'];
  const item = (id, price, extra = {}) => ({ itemId: id, venue: { name: id, pricePerPerson: price }, dayIndex: 0, startTime: '10:00', ...extra });

  test('cost = price per person x attendees; everyone attends unless listed', () => {
    expect(attendeesOf(item('x', 10), people)).toEqual(people);
    expect(attendeesOf(item('x', 10, { attendeeIds: ['cai', 'ana'] }), people)).toEqual(['cai', 'ana']);
    // People who left the trip don't count.
    expect(attendeesOf(item('x', 10, { attendeeIds: ['ana', 'gone'] }), people)).toEqual(['ana']);
    const c = itemCost(item('x', 22.5, { attendeeIds: ['ana', 'ben'] }), people);
    expect(c).toMatchObject({ totalCents: 4500, split: 'even' });
    expect(Object.fromEntries(c.shares)).toEqual({ ana: 2250, ben: 2250 });
  });

  test('a hand-checked trip: per-person totals, running totals, group total', () => {
    const items = [
      item('dinner', 22, {}), // 4 x 22.00 = 88.00 -> 22.00 each
      item('sail', 55, { attendeeIds: ['ana', 'ben'] }), // 2 x 55 = 110.00 -> 55.00 each
      item('flat', 79, { split: { type: 'weighted', weights: { ana: 2, ben: 1, cai: 1, dev: 0 } } }), // 4 x 79 = 316.00 by 2:1:1:0 -> 158, 79, 79, 0
      item('tram', 4.1, {}), // 4 x 4.10 = 16.40 -> 4.10 each
    ];
    const b = computeBudget({ items, participantIds: people, totalBudget: 500, ceilings: new Map([['ana', 200]]) });
    expect(b.perPersonCents).toEqual({ ana: 2200 + 5500 + 15800 + 410, ben: 2200 + 5500 + 7900 + 410, cai: 2200 + 7900 + 410, dev: 2200 + 410 });
    expect(b.perPersonCents).toEqual({ ana: 23910, ben: 16010, cai: 10510, dev: 2610 });
    expect(b.groupCents).toBe(8800 + 11000 + 31600 + 1640); // 53040
    expect(b.groupCents).toBe(Object.values(b.perPersonCents).reduce((a, c) => a + c, 0));
    expect(b.remainingCents).toBe(50000 - 53040);
    expect(b.overBudget).toBe(true);
    expect(b.lines[1].runningCents).toEqual({ ana: 7700, ben: 7700, cai: 2200, dev: 2200 });
    expect(b.perPerson.find((p) => p.userId === 'ana')).toEqual({ userId: 'ana', committed: 239.1, ceiling: 200, remaining: -39.1, overCeiling: true });
    expect(b.perPerson.find((p) => p.userId === 'dev')).toMatchObject({ committed: 26.1, ceiling: null, remaining: null, overCeiling: false });
  });

  test('random trips: shares always add up to item cost, and people add up to the group total', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 300; t += 1) {
      const items = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, k) => {
        const attending = people.filter(() => rand() < 0.7);
        const weighted = rand() < 0.4;
        return item(`i${k}`, Math.round(rand() * 25000) / 100, {
          attendeeIds: attending,
          ...(weighted ? { split: { type: 'weighted', weights: Object.fromEntries(people.map((p) => [p, 1 + Math.floor(rand() * 3)])) } } : {}),
        });
      });
      const b = computeBudget({ items, participantIds: people, totalBudget: 2000 });
      for (const line of b.lines) {
        expect(Object.values(line.shares).reduce((a, c) => a + c, 0)).toBe(line.totalCents);
      }
      expect(Object.values(b.perPersonCents).reduce((a, c) => a + c, 0)).toBe(b.groupCents);
      expect(b.groupCents).toBe(b.lines.reduce((a, l) => a + l.totalCents, 0));
      expect(b.lines.at(-1).runningCents).toEqual(b.perPersonCents);
    }
  });

  test('prices that break floating point add up exactly', () => {
    const items = [0.1, 0.2, 0.7, 19.99].map((p, k) => item(`i${k}`, p));
    const b = computeBudget({ items, participantIds: ['a', 'b', 'c'], totalBudget: 100 });
    expect(b.perPersonCents).toEqual({ a: 2099, b: 2099, c: 2099 });
    expect(b.groupCommitted).toBe(62.97);
    expect(b.remaining).toBe(37.03);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
});
