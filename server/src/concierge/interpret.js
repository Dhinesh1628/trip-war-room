import { DIETARY_TAGS, VENUE_CATEGORIES } from '../venues/vocabulary.js';
import { DEFAULTS, VISIT_MINUTES, toMinutes } from './constraints.js';
import { HttpError, notFound } from '../lib/errors.js';

// Turns a traveller's question (plus optional explicit fields) into the hard
// constraints the matcher enforces. This is deliberately rule-based, not
// LLM-based: what counts as "under $25" or "vegetarian" must be predictable
// and testable, because the constraints are a hard guarantee (spec 6.2/14.2).
// The LLM only phrases the answer from venues that already passed.

const CATEGORY_WORDS = [
  ['breakfast', ['breakfast', 'brunch', 'pastry', 'pastries']],
  ['lunch', ['lunch']],
  ['dinner', ['dinner', 'supper', 'restaurant', 'eat tonight']],
  ['cafe', ['cafe', 'café', 'coffee']],
  ['bar', ['bar', 'drinks', 'cocktail', 'nightlife']],
  ['lodging', ['hotel', 'hostel', 'stay', 'lodging', 'accommodation', 'guesthouse', 'apartment', 'sleep']],
  ['tour', ['tour', 'guided', 'sailing', 'day trip']],
  ['museum', ['museum', 'gallery', 'exhibition']],
  ['attraction', ['attraction', 'sight', 'landmark', 'castle', 'tower', 'aquarium', 'oceanarium']],
  ['activity', ['activity', 'something to do', 'things to do', 'show', 'fado', 'tram', 'market']],
];

const DIET_WORDS = [
  ['vegan', ['vegan', 'plant-based', 'plant based']],
  ['vegetarian', ['vegetarian', 'veggie']],
  ['halal', ['halal']],
  ['kosher', ['kosher']],
  ['gluten-free', ['gluten-free', 'gluten free', 'coeliac', 'celiac']],
  ['dairy-free', ['dairy-free', 'dairy free', 'lactose']],
  ['nut-free', ['nut-free', 'nut free', 'nut allergy', 'peanut']],
];

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b`;
const ANCHOR_PHRASE = new RegExp(
  String.raw`\b(near|after|before|close to|next to|around|by|within\s+\d+(?:\.\d+)?\s*(?:km|m)\s+of)\s+(?:our|the|my)\s+((?:${TIME})\s*)?([a-z][a-z' -]{1,40}?)(?=[,.?!]|\s+(?:under|below|for|with|that|which|and|at|on|within)\b|$)`,
  'i',
);

const contains = (text, word) => new RegExp(String.raw`(^|[^a-z])${word.replace(/[-]/g, '[- ]?')}([^a-z]|$)`, 'i').test(text);

// "5 PM" / "17:30" -> minutes after midnight, or null.
export function parseTime(text) {
  const m = new RegExp(TIME, 'i').exec(text);
  if (!m) return null;
  if (m[3]) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    return h * 60 + Number(m[2] || 0);
  }
  return Number(m[4]) * 60 + Number(m[5]);
}

export function parseQuestion(question) {
  const text = question.toLowerCase();

  // Pull out the anchor phrase first ("near our 5 PM tour"), so its time and
  // noun aren't mistaken for the slot time or the category being asked for.
  const anchorMatch = ANCHOR_PHRASE.exec(question);
  const anchorRef = anchorMatch
    ? {
        relation: anchorMatch[1].toLowerCase().startsWith('within') ? 'near' : anchorMatch[1].toLowerCase(),
        time: anchorMatch[2] ? parseTime(anchorMatch[2]) : null,
        noun: anchorMatch[anchorMatch.length - 1].trim().toLowerCase(),
      }
    : null;
  const rest = anchorMatch ? text.replace(anchorMatch[0].toLowerCase(), ' ') : text;

  const category = CATEGORY_WORDS.find(([, words]) => words.some((w) => contains(rest, w)))?.[0] ?? null;
  const dietaryTags = DIET_WORDS.filter(([, words]) => words.some((w) => contains(text, w))).map(([tag]) => tag);

  const price = /(?:under|below|less than|at most|max(?:imum)?|up to|cheaper than|<)\s*(?:us)?\$?\s*(\d+(?:\.\d{1,2})?)/i.exec(rest)
    ?? /\$\s*(\d+(?:\.\d{1,2})?)\s*(?:\/|per|a)\s*(?:person|head|pp)/i.exec(rest);
  const radius = /within\s+(\d+(?:\.\d+)?)\s*(km|kilometers?|kilometres?|m|meters?|metres?)\b/i.exec(text);
  const day = /\bday\s+(\d{1,2})\b/i.exec(text);

  return {
    category,
    dietaryTags,
    maxPricePerPerson: price ? Number(price[1]) : null,
    radiusKm: radius ? Number(radius[1]) / (radius[2].toLowerCase().startsWith('k') ? 1 : 1000) : null,
    dayIndex: day ? Number(day[1]) - 1 : null,
    time: parseTime(rest),
    anchorRef,
  };
}

// Finds the pinned item a phrase like "our 5 PM tour" refers to.
export function resolveAnchor(items, ref) {
  if (!ref || !items.length) return null;
  const noun = plain(ref.noun).replace(/s$/, '');
  const scored = items
    .map((item) => {
      let score = 0;
      if (ref.time != null && toMinutes(item.startTime) === ref.time) score += 2;
      const name = plain(item.venue.name);
      const words = noun.split(' ').filter((w) => w.length > 3);
      if (item.venue.category === noun || name.includes(noun) || words.some((w) => name.includes(w))) {
        score += 1;
      } else if (words.some((w) => plain(item.venue.description ?? '').includes(w))) {
        // e.g. "the castle" -> "Castelo Hilltop Fortress", described as a castle
        score += 0.5;
      }
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.dayIndex - b.item.dayIndex || a.item.startTime.localeCompare(b.item.startTime));
  return scored[0]?.item ?? null;
}

// Builds the full constraint set for one request.
//   ctx: { items, travellers: Map userId -> { dietaryTags, budgetCeiling },
//          participantIds, requesterId, budget: { totalBudget, perPersonCommitted, ... } }
//   explicit: optional overrides from the request body (they win over parsing)
export function buildConstraints(question, ctx, explicit = {}) {
  const parsed = parseQuestion(question);
  const notes = [];

  // ---- anchor
  let anchor = null;
  if (explicit.anchorItemId) {
    anchor = ctx.items.find((i) => String(i.itemId ?? i._id) === explicit.anchorItemId);
    if (!anchor) throw notFound('anchorItemId is not on this trip board');
  } else if (parsed.anchorRef) {
    anchor = resolveAnchor(ctx.items, parsed.anchorRef);
    if (!anchor) notes.push(`Couldn't find "${parsed.anchorRef.noun}" on the board, so distance wasn't limited`);
  }

  const category = explicit.category ?? parsed.category;
  if (category && !VENUE_CATEGORIES.includes(category)) throw new HttpError(400, 'VALIDATION_FAILED', 'Unknown category');

  // ---- budget ceiling: question > requester's headroom > group per-person headroom
  let maxPricePerPerson = explicit.maxPricePerPerson ?? parsed.maxPricePerPerson;
  let budgetSource = maxPricePerPerson != null ? 'question' : null;
  if (maxPricePerPerson == null) {
    const committed = ctx.budget.perPersonCommitted;
    const mine = ctx.travellers.get(ctx.requesterId)?.budgetCeiling;
    if (mine != null) {
      maxPricePerPerson = round2(mine - committed);
      budgetSource = 'your remaining budget';
    } else if (ctx.budget.participantCount > 0) {
      maxPricePerPerson = round2(ctx.budget.remaining / ctx.budget.participantCount);
      budgetSource = "the group's remaining budget per person";
    }
  }

  // ---- dietary: everyone attending (Phase 3: everyone attends everything) + the question
  const declared = ctx.participantIds.flatMap((id) => ctx.travellers.get(id)?.dietaryTags ?? []);
  const dietaryTags = [...new Set([...(explicit.dietaryTags ?? []), ...parsed.dietaryTags, ...declared])]
    .filter((t) => DIETARY_TAGS.includes(t))
    .sort();

  // ---- time slot the venue must be open for
  const minutes = VISIT_MINUTES[category] ?? 60;
  const buffer = explicit.travelBufferMinutes ?? DEFAULTS.travelBufferMinutes;
  let slot = null;
  const explicitTime = explicit.time != null ? toMinutes(explicit.time) : parsed.time;
  if (explicitTime != null) {
    slot = { start: explicitTime, end: explicitTime + minutes, reason: 'the time you asked for' };
  } else if (anchor) {
    if (parsed.anchorRef?.relation === 'before') {
      const end = toMinutes(anchor.startTime) - buffer;
      slot = { start: end - minutes, end, reason: `${buffer} min before ${anchor.venue.name}` };
    } else {
      const start = toMinutes(anchor.endTime) + buffer;
      slot = { start, end: start + minutes, reason: `${buffer} min after ${anchor.venue.name} ends` };
    }
  }

  return {
    category,
    maxPricePerPerson: maxPricePerPerson == null ? null : Math.max(0, maxPricePerPerson),
    budgetSource,
    dietaryTags,
    slot,
    anchor: anchor
      ? {
          itemId: String(anchor.itemId ?? anchor._id),
          venueId: anchor.venueId,
          name: anchor.venue.name,
          coordinates: anchor.venue.coordinates,
          dayIndex: anchor.dayIndex,
          startTime: anchor.startTime,
          endTime: anchor.endTime,
        }
      : null,
    radiusKm: explicit.radiusKm ?? parsed.radiusKm ?? DEFAULTS.radiusKm,
    dayIndex: explicit.dayIndex ?? parsed.dayIndex ?? anchor?.dayIndex ?? null,
    // Don't suggest something already pinned.
    excludeVenueIds: ctx.items.map((i) => i.venueId),
    notes,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Lowercase without accents, so "belem" matches "Belém".
const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
