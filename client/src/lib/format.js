const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const money = (n) => usd.format(Number(n) || 0);
// Whole dollars when there are no cents ($22, but $22.50).
export const price = (n) => (Number.isInteger(Number(n)) ? usd0.format(n) : usd.format(n));

const DAY_MS = 86400000;
export function dayInfo(startDate, dayIndex) {
  const d = new Date(Date.parse(`${startDate}T00:00:00Z`) + dayIndex * DAY_MS);
  return {
    iso: d.toISOString().slice(0, 10),
    label: d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
    long: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }),
  };
}

export function dateRange(start, end) {
  const f = (s, o) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  return `${f(start, { month: 'short', day: 'numeric' })} to ${f(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
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
