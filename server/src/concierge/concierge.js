import mongoose from 'mongoose';
import { buildConstraints } from './interpret.js';
import { filterCandidates, rankCandidates, activeRules, toHHMM } from './constraints.js';
import { factsFor, writeAnswer, noMatchAnswer, MAX_CANDIDATES } from './answer.js';
import { publicItem } from '../board/boardState.js';
import { sanitizeChat } from '../chat/sanitize.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

// The AI Concierge Engine (spec 6.2, 7.3.3). One question in, one grounded
// answer out:
//   1. interpret the question into hard constraints   (interpret.js, rules)
//   2. filter the destination's venues through them    (constraints.js, rules)
//   3. rank what's left 40/30/30                       (constraints.js, rules)
//   4. phrase the answer from the top candidates       (answer.js, Claude or template)
// Steps 1-3 never involve the LLM, so every suggestion satisfies every active
// constraint no matter what the model writes.

const RATE_WINDOW_MS = 60_000;

// Per-traveller limit across all trips. `askLog` must outlive rooms (a REST
// question opens and closes its room), so the gateway owns it.
export function rateLimitAsk(askLog, userId, limit) {
  const now = Date.now();
  const recent = (askLog.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= limit) {
    throw new HttpError(429, 'RATE_LIMITED', `You can ask the Concierge ${limit} questions a minute; try again shortly`);
  }
  recent.push(now);
  askLog.set(userId, recent);
}

export async function askConcierge({ room, userId, question, explicit = {}, llm, config }) {
  const started = performance.now();
  const clean = sanitizeChat(question);
  if (clean.length < 3) throw badRequest('Ask a question of at least 3 characters');
  if (clean.length > 500) throw badRequest('Questions can be at most 500 characters');

  // Board items, with the catalog description added so "near the castle" can
  // find "Castelo Hilltop Fortress".
  const items = room.boardItems().map((i) => {
    const item = publicItem(i);
    return { ...item, venue: { ...item.venue, description: room.venues.get(i.venueId)?.description ?? '' } };
  });
  const constraints = buildConstraints(
    clean,
    {
      items,
      travellers: room.travellers,
      participantIds: room.participantIds,
      requesterId: userId,
      budget: room.budget(),
      currency: room.currency,
    },
    explicit,
  );

  const venues = [...room.venues.values()];
  const { valid, rejected } = filterCandidates(venues, constraints);
  const ranked = rankCandidates(valid, constraints);
  const weather = room.weatherFor(constraints.dayIndex);
  const facts = factsFor({ question: clean, constraints, ranked, weather });

  let reply;
  let nearMisses = [];
  if (!ranked.length) {
    const none = noMatchAnswer(constraints, rejected);
    nearMisses = none.nearMisses;
    reply = { answer: none.answer, suggestedVenueId: null, citedVenueIds: [], mode: 'no_match' };
  } else {
    reply = await writeAnswer({
      facts,
      llm,
      config,
      allVenueNames: venues.map((v) => v.name),
      tripId: room.tripId,
    });
  }

  // Grounding evidence (spec 6.2): exactly which records the answer used.
  const cited = reply.citedVenueIds.map((id) => room.venues.get(id)).filter(Boolean);
  const sourceEvents = [
    ...reply.citedVenueIds.map((id) => `venue:${id}`),
    ...(constraints.anchor ? [`item:${constraints.anchor.itemId}`] : []),
    ...(weather ? [`weather:${weather.date}`] : []),
  ];
  const rankedById = new Map(ranked.map((r) => [r.venue.venueId, r]));

  const latencyMs = Math.round(performance.now() - started);
  const payload = {
    questionId: String(new mongoose.Types.ObjectId()),
    tripId: room.tripId,
    userId,
    question: clean,
    answer: reply.answer,
    suggestedVenueId: reply.suggestedVenueId,
    sourceEvents,
    sources: cited.map((v) => ({
      venueId: v.venueId,
      name: v.name,
      category: v.category,
      pricePerPerson: v.pricePerPerson,
      dietaryTags: v.dietaryTags,
      hours: v.hours,
      coordinates: v.coordinates,
      distanceKm: rankedById.get(v.venueId)?.distanceKm ?? null,
      walkMinutes: rankedById.get(v.venueId)?.walkMinutes ?? null,
    })),
    weather,
    constraints: {
      active: activeRules(constraints),
      category: constraints.category,
      maxPricePerPerson: constraints.maxPricePerPerson,
      budgetSource: constraints.budgetSource,
      dietaryTags: constraints.dietaryTags,
      mustBeOpen: constraints.slot
        ? { from: toHHMM(constraints.slot.start), to: toHHMM(constraints.slot.end), reason: constraints.slot.reason }
        : null,
      anchor: constraints.anchor,
      radiusKm: constraints.anchor ? constraints.radiusKm : null,
      notes: constraints.notes,
    },
    candidates: ranked.slice(0, MAX_CANDIDATES).map((r) => ({
      venueId: r.venue.venueId,
      name: r.venue.name,
      pricePerPerson: r.venue.pricePerPerson,
      distanceKm: r.distanceKm,
      score: r.score,
      scores: r.scores,
    })),
    validCount: valid.length,
    rejectedCount: rejected.length,
    nearMisses: nearMisses.map((m) => ({ venueId: m.venue.venueId, name: m.venue.name, failures: m.failures })),
    mode: reply.mode,
    ...(reply.fallbackReason ? { fallbackReason: reply.fallbackReason } : {}),
    ...(reply.model ? { model: reply.model } : {}),
    latencyMs,
    generatedAt: new Date().toISOString(),
  };

  log.info('concierge.answer', {
    tripId: room.tripId,
    correlationId: room.correlationId,
    userId,
    questionId: payload.questionId,
    mode: payload.mode,
    fallbackReason: reply.fallbackReason,
    suggestedVenueId: payload.suggestedVenueId,
    valid: valid.length,
    latencyMs,
    llmMs: reply.llmMs,
    inputTokens: reply.usage?.input_tokens,
    outputTokens: reply.usage?.output_tokens,
  });
  return payload;
}
