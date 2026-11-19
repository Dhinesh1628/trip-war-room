// Money is shown in the trip's currency: rupees for the Indian cities, with
// Indian digit grouping (₹1,20,000). Whole amounts drop the paise.
const LOCALE = { INR: 'en-IN', USD: 'en-US' };
const formatters = new Map();
function formatter(currency, whole) {
  const key = `${currency}:${whole}`;
  if (!formatters.has(key)) {
    formatters.set(
      key,
      new Intl.NumberFormat(LOCALE[currency] ?? 'en-IN', {
        style: 'currency',
        currency,
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      }),
    );
  }
  return formatters.get(key);
}

export const DEFAULT_CURRENCY = 'INR';
export const price = (n, currency = DEFAULT_CURRENCY) => {
  const v = Number(n) || 0;
  return formatter(currency, Math.round(v * 100) % 100 === 0).format(v);
};
// Kept for older call sites: same as price.
export const money = price;

const DAY_MS = 86400000;
export function dayInfo(startDate, dayIndex) {
  const d = new Date(Date.parse(`${startDate}T00:00:00Z`) + dayIndex * DAY_MS);
  return {
    iso: d.toISOString().slice(0, 10),
    label: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
    long: d.toLocaleDateString('en-IN', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }),
  };
}

export function dateRange(start, end) {
  const f = (s, o) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', ...o });
  return `${f(start, { day: 'numeric', month: 'short' })} to ${f(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// "10–13 Dec" for cards.
export function shortRange(start, end) {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const m = (d) => d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  return m(s) === m(e) ? `${s.getUTCDate()}–${e.getUTCDate()} ${m(e)}` : `${s.getUTCDate()} ${m(s)} – ${e.getUTCDate()} ${m(e)}`;
}

export const initials = (name = '?') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

export const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const toHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export const VISIT_MINUTES = { breakfast: 45, lunch: 60, dinner: 90, cafe: 45, bar: 90, activity: 120, tour: 120, museum: 90, attraction: 90, lodging: 60 };

export const hoursText = (h) => (h.open === '00:00' && h.close === '23:59' ? 'Open 24 hours' : `${h.open}–${h.close}`);
export const cityOf = (name = '') => name.split(',')[0];
