import { FOOD_CATEGORIES } from '../venues/vocabulary.js';

// Hybrid recommendation engine (spec 6.3): content-based + collaborative
// filtering with a group-affinity boost. Pure functions over plain data, so
// the same code runs live (from the interactions collection) and in the
// offline Precision@5 evaluation.
//
//   content(u, v)  cosine similarity between v's features and u's taste
//                  profile (liked features minus disliked ones)
//   collab(u, v)   how much people with similar likes liked v; people u has
//                  travelled with count 1.5x (group affinity)
//   hybrid         ALPHA * content + (1 - ALPHA) * collab
//                  (content only for people with fewer than 3 signals; a
//                  popularity ranking for people with none: cold start)

export const ALPHA = 0.5;
export const CO_TRAVEL_BOOST = 1.5;
export const MIN_SIGNALS_FOR_COLLAB = 3;

const priceBand = (p) => (p < 15 ? 'budget' : p < 30 ? 'moderate' : p < 60 ? 'premium' : 'luxury');

// Sparse feature vector for a venue.
export function features(venue) {
  const f = new Map([
    [`cat:${venue.category}`, 1],
    [`price:${priceBand(venue.pricePerPerson)}`, 0.8],
    [`area:${venue.neighborhood}`, 0.4],
    [venue.indoor ? 'indoor' : 'outdoor', 0.3],
  ]);
  for (const t of venue.dietaryTags ?? []) f.set(`diet:${t}`, 0.6);
  return f;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    if (b.has(k)) dot += v * b.get(k);
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const signal = (i) => (i.liked ? 1 : -1) * (i.weight ?? 1);

// Builds the model from interaction rows: { userId, venueId, liked, weight, coTraveledWith }.
export function buildModel(interactions, venues) {
  const venueById = new Map(venues.map((v) => [v.venueId, v]));
  const vectors = new Map(venues.map((v) => [v.venueId, features(v)]));
  const ratings = new Map(); // userId -> Map venueId -> summed signal
  const coTravel = new Map(); // userId -> Set of userIds
  for (const i of interactions) {
    if (!venueById.has(i.venueId)) continue;
    const u = String(i.userId);
    if (!ratings.has(u)) ratings.set(u, new Map());
    const r = ratings.get(u);
    r.set(i.venueId, (r.get(i.venueId) ?? 0) + signal(i));
    if (!coTravel.has(u)) coTravel.set(u, new Set());
    for (const c of i.coTraveledWith ?? []) coTravel.get(u).add(String(c));
  }
  // Taste profile: sum of feature vectors weighted by each signal.
  const profiles = new Map();
  for (const [u, r] of ratings) {
    const p = new Map();
    for (const [venueId, s] of r) {
      for (const [k, v] of vectors.get(venueId)) p.set(k, (p.get(k) ?? 0) + s * v);
    }
    profiles.set(u, p);
  }
  // Popularity for cold start: rating, nudged by review count.
  const maxReviews = Math.max(1, ...venues.map((v) => v.reviewCount ?? 0));
  const popularity = new Map(
    venues.map((v) => [v.venueId, 0.8 * (v.rating / 5) + 0.2 * (Math.log10(1 + (v.reviewCount ?? 0)) / Math.log10(1 + maxReviews))]),
  );
  return { venues, venueById, vectors, ratings, profiles, coTravel, popularity, simCache: new Map() };
}

// Similarity between two people's likes (cosine over venues), boosted for co-travellers.
function userSimilarity(model, a, b) {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (!model.simCache.has(key)) model.simCache.set(key, cosine(model.ratings.get(a), model.ratings.get(b)));
  const base = model.simCache.get(key);
  const together = model.coTravel.get(a)?.has(b) || model.coTravel.get(b)?.has(a);
  return together ? base * CO_TRAVEL_BOOST : base;
}

// Scores every venue for one person. Returns Map venueId -> { score, content, collab, why }.
export function scoreForUser(model, userId, { alpha = ALPHA } = {}) {
  const u = String(userId);
  const mine = model.ratings.get(u);
  const out = new Map();

  if (!mine || mine.size === 0) {
    for (const v of model.venues) out.set(v.venueId, { score: model.popularity.get(v.venueId), content: 0, collab: 0, why: 'popular with visitors' });
    return out;
  }

  const profile = model.profiles.get(u);
  const content = new Map(model.venues.map((v) => [v.venueId, Math.max(0, cosine(profile, model.vectors.get(v.venueId)))]));

  // Collaborative part: weighted average of neighbours' signals.
  const collab = new Map();
  const viaCoTravel = new Map();
  const useCollab = mine.size >= MIN_SIGNALS_FOR_COLLAB;
  if (useCollab) {
    const raw = new Map();
    let total = 0;
    for (const [other, theirs] of model.ratings) {
      if (other === u) continue;
      const sim = userSimilarity(model, u, other);
      if (sim <= 0) continue;
      total += sim;
      const together = model.coTravel.get(u)?.has(other);
      for (const [venueId, s] of theirs) {
        raw.set(venueId, (raw.get(venueId) ?? 0) + sim * s);
        if (together && s > 0) viaCoTravel.set(venueId, true);
      }
    }
    const max = Math.max(1e-9, ...[...raw.values()].map((x) => Math.max(0, x)));
    for (const [venueId, x] of raw) collab.set(venueId, total ? Math.max(0, x) / max : 0);
  }

  const a = useCollab ? alpha : 1;
  for (const v of model.venues) {
    const c = content.get(v.venueId) ?? 0;
    const k = collab.get(v.venueId) ?? 0;
    const why =
      useCollab && k * (1 - a) > c * a
        ? viaCoTravel.get(v.venueId)
          ? 'liked by people you have travelled with'
          : 'liked by travellers with similar taste'
        : explainContent(profile, model.vectors.get(v.venueId));
    out.set(v.venueId, { score: a * c + (1 - a) * k, content: c, collab: k, why });
  }
  return out;
}

const CATEGORY_PLURAL = {
  breakfast: 'breakfast spots',
  lunch: 'lunch spots',
  dinner: 'dinner spots',
  cafe: 'cafes',
  bar: 'bars',
  activity: 'activities',
  tour: 'tours',
  museum: 'museums',
  attraction: 'sights',
  lodging: 'places to stay',
};

// The feature that contributes most to the content match, in words.
function explainContent(profile, vector) {
  let best = null;
  let bestValue = 0;
  for (const [k, v] of vector) {
    const contribution = (profile.get(k) ?? 0) * v;
    if (contribution > bestValue) {
      best = k;
      bestValue = contribution;
    }
  }
  if (!best) return 'something new to try';
  const [kind, value] = best.split(':');
  if (kind === 'cat') return `you like ${CATEGORY_PLURAL[value] ?? `${value}s`}`;
  if (kind === 'diet') return `matches your ${value} picks`;
  if (kind === 'price') return `fits your usual ${value} spending`;
  if (kind === 'area') return `in ${value}, an area you like`;
  return best === 'indoor' ? 'indoors, like your other picks' : 'outdoors, like your other picks';
}

// "Recommended for your group": averages each member's scores, keeps only
// venues the whole group can use (dietary rule for food places), skips what
// is already on the board, and returns the top `limit`.
export function recommendForGroup(model, memberIds, { exclude = [], dietaryTags = [], limit = 5, alpha = ALPHA } = {}) {
  const members = memberIds.map(String);
  const perMember = members.map((m) => scoreForUser(model, m, { alpha }));
  const skip = new Set(exclude);
  const ranked = [];
  for (const v of model.venues) {
    if (skip.has(v.venueId)) continue;
    if (dietaryTags.length && FOOD_CATEGORIES.includes(v.category) && !dietaryTags.every((t) => v.dietaryTags.includes(t))) continue;
    const scores = perMember.map((s) => s.get(v.venueId));
    const score = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    // The member with the strongest match explains it.
    const top = scores.reduce((best, s) => (s.score > best.score ? s : best), scores[0]);
    ranked.push({ venue: v, score, why: top.why });
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.venue.venueId.localeCompare(b.venue.venueId))
    .slice(0, limit)
    .map((r) => ({
      venueId: r.venue.venueId,
      name: r.venue.name,
      category: r.venue.category,
      neighborhood: r.venue.neighborhood,
      pricePerPerson: r.venue.pricePerPerson,
      dietaryTags: r.venue.dietaryTags,
      rating: r.venue.rating,
      score: Math.round(r.score * 1000) / 1000,
      why: r.why,
    }));
}
