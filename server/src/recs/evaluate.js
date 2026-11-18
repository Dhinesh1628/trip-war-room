import { buildModel, scoreForUser } from './recommender.js';

// Offline evaluation (spec 1.3): Precision@5 against a held-out set.
// For every traveller with at least `minTest` held-out likes, recommend the
// top 5 venues they have NOT interacted with in training, and count how many
// are among their held-out likes. Precision@5 = hits / 5, averaged.

export function precisionAtK(venues, { train, test }, { k = 5, minTest = 5, scorer = 'hybrid', alpha } = {}) {
  const model = buildModel(train, venues);
  const seen = new Map();
  for (const i of train) {
    if (!seen.has(i.userId)) seen.set(i.userId, new Set());
    seen.get(i.userId).add(i.venueId);
  }
  const results = [];
  for (const [userId, held] of test) {
    if (held.size < minTest) continue;
    const scores = scoreForUser(model, userId, alpha == null ? {} : { alpha });
    const pick = (s) =>
      scorer === 'content' ? s.content : scorer === 'collab' ? s.collab : scorer === 'popularity' ? model.popularity.get(s.venueId) : s.score;
    const top = [...scores.entries()]
      .filter(([venueId]) => !seen.get(userId)?.has(venueId))
      .map(([venueId, s]) => ({ venueId, value: pick({ ...s, venueId }) }))
      .sort((a, b) => b.value - a.value || a.venueId.localeCompare(b.venueId))
      .slice(0, k);
    const hits = top.filter((t) => held.has(t.venueId)).length;
    results.push({ userId, hits, precision: hits / k });
  }
  const mean = results.reduce((s, r) => s + r.precision, 0) / (results.length || 1);
  return { precisionAt5: Math.round(mean * 1000) / 1000, users: results.length, results };
}
