import { describe, expect, test } from 'vitest';
import { filterVenues, sortVenues, isOpenAt, matchesQuery, nowInIndia, activeFilterCount, DEFAULT_FILTERS } from '../lib/filters.js';
import { price, shortRange, dateRange, dayInfo } from '../lib/format.js';
import { VENUES } from './helpers.jsx';

const ALL = [...VENUES.jaipur.map((v) => ({ ...v, destination: 'jaipur', destinationName: 'Jaipur, India' })), ...VENUES.goa.map((v) => ({ ...v, destination: 'goa', destinationName: 'Goa, India' }))];
const names = (list) => list.map((v) => v.name);
const f = (o) => ({ ...DEFAULT_FILTERS, ...o });

describe('explore search and filters', () => {
  test('typed search matches name, area, food words and city, every word', () => {
    expect(names(filterVenues(ALL, f({ query: 'thali' })))).toEqual(['Dal Baati House']);
    expect(names(filterVenues(ALL, f({ query: 'baga' })))).toEqual(['Baga Beach Shack']);
    expect(names(filterVenues(ALL, f({ query: 'goa inn' })))).toEqual(['Panjim Heritage Inn']);
    expect(filterVenues(ALL, f({ query: 'nothing like this' }))).toEqual([]);
    expect(matchesQuery({ name: 'Café Ré', neighborhood: '', category: 'cafe', description: '' }, 'cafe re')).toBe(true);
  });

  test('city, category, price, rating and dietary filters combine', () => {
    expect(names(filterVenues(ALL, f({ city: 'goa' })))).toEqual(['Baga Beach Shack', 'Panjim Heritage Inn']);
    expect(names(filterVenues(ALL, f({ categories: ['lodging'] })))).toEqual(['Panjim Heritage Inn']);
    expect(names(filterVenues(ALL, f({ maxPrice: 500 })))).toEqual(['Hawa Mahal', 'Dal Baati House']);
    expect(names(filterVenues(ALL, f({ minRating: 4.5 })))).toEqual(['Hawa Mahal', 'Palace Courtyard Restaurant', 'Panjim Heritage Inn']);
    expect(names(filterVenues(ALL, f({ diets: ['vegetarian', 'gluten-free'] })))).toEqual(['Palace Courtyard Restaurant']);
    expect(activeFilterCount(f({ maxPrice: 500, diets: ['vegan', 'halal'], query: ' x ' }))).toBe(4);
  });

  test('"open now" handles normal, past-midnight and 24-hour places', () => {
    expect(isOpenAt({ open: '09:00', close: '16:30' }, 10 * 60)).toBe(true);
    expect(isOpenAt({ open: '09:00', close: '16:30' }, 16 * 60 + 30)).toBe(false);
    expect(isOpenAt({ open: '18:00', close: '02:00' }, 60)).toBe(true);
    expect(isOpenAt({ open: '18:00', close: '02:00' }, 12 * 60)).toBe(false);
    expect(isOpenAt({ open: '00:00', close: '23:59' }, 23 * 60 + 59)).toBe(true);
    expect(names(filterVenues(ALL, f({ openNow: true }), 20 * 60))).toEqual(['Dal Baati House', 'Palace Courtyard Restaurant', 'Baga Beach Shack', 'Panjim Heritage Inn']);
  });

  test('"now" is Indian time', () => {
    expect(nowInIndia(new Date('2026-12-10T00:00:00Z'))).toBe(5 * 60 + 30); // 05:30 IST
  });

  test('sorting: top rated, price both ways, most reviewed; ties are stable', () => {
    expect(names(sortVenues(ALL, 'top'))[0]).toBe('Palace Courtyard Restaurant');
    expect(names(sortVenues(ALL, 'priceLow'))).toEqual(['Hawa Mahal', 'Dal Baati House', 'Baga Beach Shack', 'Palace Courtyard Restaurant', 'Panjim Heritage Inn']);
    expect(names(sortVenues(ALL, 'priceHigh'))[0]).toBe('Panjim Heritage Inn');
    expect(names(sortVenues(ALL, 'reviews'))[0]).toBe('Hawa Mahal');
    expect(sortVenues(ALL, 'top')).not.toBe(ALL); // never sorts the caller's array in place
  });
});

describe('formatting', () => {
  test('rupees with Indian digit grouping; paise only when needed', () => {
    expect(price(120000)).toBe('₹1,20,000');
    expect(price(50)).toBe('₹50');
    expect(price(12.5)).toBe('₹12.50');
    expect(price(22, 'USD')).toBe('$22');
  });
  test('dates, also in other languages', () => {
    expect(shortRange('2026-12-10', '2026-12-13')).toBe('10–13 Dec');
    expect(shortRange('2026-12-30', '2027-01-02')).toBe('30 Dec – 2 Jan');
    expect(dateRange('2026-12-10', '2026-12-13')).toBe('10 Dec – 13 Dec 2026');
    expect(dayInfo('2026-12-10', 0).label).toBe('Thu 10');
    expect(dayInfo('2026-12-10', 0, 'hi').label).not.toBe('Thu 10');
  });
});
