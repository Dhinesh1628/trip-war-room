import { distanceKm } from '../venues/geo.js';
import { FOOD_CATEGORIES } from '../venues/vocabulary.js';

// The hard-constraint matcher (spec 6.2). Pure functions, no I/O, so the
// rules can be tested exhaustively. A venue is valid only if it passes EVERY
// active rule; the LLM is never asked to judge validity.

export const DEFAULTS = Object.freeze({
  radiusKm: 2, // spec 6.2 default proximity radius
  travelBufferMinutes: 30, // time to get from the anchor event to the venue
});

// How long a visit lasts, by category, when the question doesn't say.
export const VISIT_MINUTES = Object.freeze({
  breakfast: 45,
  lunch: 60,
  dinner: 90,
  cafe: 45,
  bar: 90,
  activity: 120,
  tour: 120,
  museum: 90,
  attraction: 90,
  lodging: 60, // check-in window
});

// ---- time helpers ("HH:MM" <-> minutes after midnight) ----------------------

export const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const toHHMM = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Opening window in minutes. If close <= open the venue is open past midnight,
// so the window runs into the next day (e.g. 18:00-01:00 -> 1080..1500).
export function openWindow(hours) {
  const open = toMinutes(hours.open);
  let close = toMinutes(hours.close);
  if (hours.open === '00:00' && hours.close === '23:59') close = 1440; // always open
  else if (close <= open) close += 1440;
  return { open, close };
}

// True when the venue is open for the whole slot [start, end) (minutes).
export function isOpenFor(hours, slot) {
  if (hours.open === '00:00' && hours.close === '23:59') return true; // always open, any slot
  const w = openWindow(hours);
  // Try the slot as given and, for venues open past midnight, shifted a day
  // (a 00:30 slot at a bar open 22:00-03:00 is inside 22:00..27:00).
  return [0, 1440].some((shift) => slot.start + shift >= w.open && slot.end + shift <= w.close);
}

// ---- the four rules ---------------------------------------------------------

// Each rule returns null when the venue passes, or a short reason it fails.
export const RULES = {
  budget(venue, c) {
    if (c.maxPricePerPerson == null) return null;
    return venue.pricePerPerson <= c.maxPricePerPerson
      ? null
      : `$${venue.pricePerPerson} is over the $${c.maxPricePerPerson} ceiling`;
  },
  dietary(venue, c) {
    if (!c.dietaryTags?.length || !FOOD_CATEGORIES.includes(venue.category)) return null;
    const missing = c.dietaryTags.filter((t) => !venue.dietaryTags.includes(t));
    return missing.length ? `no ${missing.join(', ')} option` : null;
  },
  hours(venue, c) {
    if (!c.slot) return null;
    return isOpenFor(venue.hours, c.slot)
      ? null
      : `open ${venue.hours.open}-${venue.hours.close}, not for ${toHHMM(c.slot.start)}-${toHHMM(c.slot.end)}`;
  },
  proximity(venue, c) {
    if (!c.anchor) return null;
    const km = distanceKm(c.anchor.coordinates, venue.coordinates);
    return km <= c.radiusKm ? null : `${km.toFixed(1)} km away (limit ${c.radiusKm} km)`;
  },
};

export const RULE_NAMES = Object.keys(RULES);

// Which rules are switched on for this request (for the response payload).
export function activeRules(c) {
  return {
    budget: c.maxPricePerPerson != null,
    dietary: Boolean(c.dietaryTags?.length),
    hours: Boolean(c.slot),
    proximity: Boolean(c.anchor),
  };
}

// Splits venues into valid ones and rejected ones (with every failed rule).
export function filterCandidates(venues, constraints) {
  const valid = [];
  const rejected = [];
  for (const venue of venues) {
    if (constraints.category && venue.category !== constraints.category) continue;
    if (constraints.excludeVenueIds?.includes(venue.venueId)) continue;
    const failures = {};
    for (const name of RULE_NAMES) {
      const why = RULES[name](venue, constraints);
      if (why) failures[name] = why;
    }
    if (Object.keys(failures).length) rejected.push({ venue, failures });
    else valid.push(venue);
  }
  return { valid, rejected };
}

// ---- ranking (spec 6.2: 40% proximity, 30% rating/popularity, 30% budget headroom)

export const WEIGHTS = Object.freeze({ proximity: 0.4, rating: 0.3, headroom: 0.3 });

export function rankCandidates(valid, constraints) {
  if (!valid.length) return [];
  const maxReviews = Math.max(...valid.map((v) => v.reviewCount), 1);
  const maxPrice = Math.max(...valid.map((v) => v.pricePerPerson));

  return valid
    .map((venue) => {
      const km = constraints.anchor ? distanceKm(constraints.anchor.coordinates, venue.coordinates) : null;
      // Closer is better; with no anchor every venue scores the same here.
      const proximity = km == null ? 1 : Math.max(0, 1 - km / constraints.radiusKm);
      // Rating dominates; review count (popularity, log-scaled) breaks ties.
      const rating = 0.75 * (venue.rating / 5) + 0.25 * (Math.log10(1 + venue.reviewCount) / Math.log10(1 + maxReviews));
      // Margin under the ceiling, not just being under it.
      const ceiling = constraints.maxPricePerPerson ?? maxPrice;
      const headroom = ceiling > 0 ? Math.max(0, (ceiling - venue.pricePerPerson) / ceiling) : 0;
      const score = WEIGHTS.proximity * proximity + WEIGHTS.rating * rating + WEIGHTS.headroom * headroom;
      return {
        venue,
        distanceKm: km == null ? null : Math.round(km * 1000) / 1000,
        walkMinutes: km == null ? null : walkMinutes(km),
        scores: { proximity: round3(proximity), rating: round3(rating), headroom: round3(headroom) },
        score: round3(score),
      };
    })
    .sort((a, b) => b.score - a.score || a.venue.venueId.localeCompare(b.venue.venueId));
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// Average city walking pace, with a 25% allowance for hills and crossings.
export const walkMinutes = (km) => Math.max(1, Math.round(((km * 1.25) / 4.8) * 60));
