// Explore search: typed text, filters and sorting over the venue catalog.
// Pure functions, so they are easy to test.

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Minutes after midnight in India right now (all destinations are IST).
export function nowInIndia(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// Is the venue open at this minute of the day? Handles past-midnight closing.
export function isOpenAt(hours, minute) {
  if (hours.open === '00:00' && hours.close === '23:59') return true;
  const o = toMin(hours.open);
  const c = toMin(hours.close);
  return c > o ? minute >= o && minute < c : minute >= o || minute < c;
}

// Every word in the query must start a word in the venue's text ("fort"
// finds "Fort" and "fortress", but "inn" doesn't find "dinner").
export function matchesQuery(v, query) {
  const words = norm(query).split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return true;
  const tokens = norm([v.name, v.neighborhood, v.category, v.description, v.destinationName, ...(v.dietaryTags ?? [])].join(' '))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.every((w) => tokens.some((tok) => tok.startsWith(w)));
}

export const DEFAULT_FILTERS = Object.freeze({ query: '', city: 'all', categories: null, maxPrice: null, minRating: null, diets: [], openNow: false });

export function filterVenues(venues, f = DEFAULT_FILTERS, now = nowInIndia()) {
  return venues.filter(
    (v) =>
      (f.city === 'all' || v.destination === f.city) &&
      (!f.categories || f.categories.includes(v.category)) &&
      (f.maxPrice == null || v.pricePerPerson <= f.maxPrice) &&
      (f.minRating == null || v.rating >= f.minRating) &&
      (!f.diets?.length || f.diets.every((d) => v.dietaryTags.includes(d))) &&
      (!f.openNow || isOpenAt(v.hours, now)) &&
      matchesQuery(v, f.query),
  );
}

export const SORTS = ['top', 'priceLow', 'priceHigh', 'reviews'];

export function sortVenues(list, sort = 'top') {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const cmp = {
    top: (a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount || byName(a, b),
    priceLow: (a, b) => a.pricePerPerson - b.pricePerPerson || b.rating - a.rating || byName(a, b),
    priceHigh: (a, b) => b.pricePerPerson - a.pricePerPerson || b.rating - a.rating || byName(a, b),
    reviews: (a, b) => b.reviewCount - a.reviewCount || b.rating - a.rating || byName(a, b),
  }[sort] ?? (() => 0);
  return [...list].sort(cmp);
}

// How many filters (beyond city and category) are switched on.
export const activeFilterCount = (f) =>
  (f.maxPrice != null ? 1 : 0) + (f.minRating != null ? 1 : 0) + (f.diets?.length ?? 0) + (f.openNow ? 1 : 0) + (f.query.trim() ? 1 : 0);
