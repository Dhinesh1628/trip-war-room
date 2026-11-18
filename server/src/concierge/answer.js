import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toHHMM } from './constraints.js';
import { log } from '../lib/logger.js';

// Writes the Concierge's reply. Two ways, same guarantees:
//  - "llm": Claude phrases a reply from the already-filtered, ranked
//    candidates. Structured output limits venue ids to those candidates, and
//    the reply is then checked: every venue name, price and time it mentions
//    must appear in the facts it was given.
//  - "template": a deterministic sentence built from the same facts. Used
//    with no API key, on a timeout, a refusal, an API error, or a reply that
//    fails the grounding check.
// Either way the suggested venue is always one that passed every hard rule.

export const MAX_CANDIDATES = 5;

const SYSTEM = `You are the Concierge inside a group trip-planning app.
You answer one traveller's question using ONLY the candidate venues supplied in the facts. Every candidate already satisfies the group's budget, dietary, opening-hours and distance rules, and they are listed best match first.

Rules:
- Recommend exactly one candidate as suggestedVenueId. Prefer the first unless the question clearly favours another.
- Only state facts that appear in the supplied data: names, prices, dietary tags, opening hours, walking minutes, distances, weather. Never invent a venue, price, time or feature.
- Write prices exactly as given, with a dollar sign (for example $22). Write times as HH:MM in 24-hour form exactly as given.
- Keep the answer to two or three short sentences, plain text, no lists, no markdown, no emoji.
- citedVenueIds lists every venue you mention, including suggestedVenueId.`;

const replySchema = (ids) =>
  z
    .object({
      answer: z.string().min(1).max(1200),
      suggestedVenueId: z.enum(ids),
      citedVenueIds: z.array(z.enum(ids)).min(1).max(MAX_CANDIDATES),
    })
    .strict();

// JSON schema for structured output: venue ids can only be candidate ids.
const outputSchema = (ids) => ({
  type: 'object',
  properties: {
    answer: { type: 'string' },
    suggestedVenueId: { type: 'string', enum: ids },
    citedVenueIds: { type: 'array', items: { type: 'string', enum: ids } },
  },
  required: ['answer', 'suggestedVenueId', 'citedVenueIds'],
  additionalProperties: false,
});

// ---- facts given to the model (and used by the grounding check) -------------

export function factsFor({ question, constraints, ranked, weather }) {
  return {
    question,
    rulesApplied: {
      category: constraints.category,
      maxPricePerPersonUSD: constraints.maxPricePerPerson,
      budgetSource: constraints.budgetSource,
      dietaryTags: constraints.dietaryTags,
      mustBeOpen: constraints.slot
        ? { from: toHHMM(constraints.slot.start), to: toHHMM(constraints.slot.end), because: constraints.slot.reason }
        : null,
      nearTo: constraints.anchor
        ? {
            name: constraints.anchor.name,
            startTime: constraints.anchor.startTime,
            endTime: constraints.anchor.endTime,
            radiusKm: constraints.radiusKm,
          }
        : null,
    },
    weather: weather ?? null,
    candidates: ranked.slice(0, MAX_CANDIDATES).map((r, i) => ({
      rank: i + 1,
      venueId: r.venue.venueId,
      name: r.venue.name,
      category: r.venue.category,
      neighborhood: r.venue.neighborhood,
      pricePerPersonUSD: r.venue.pricePerPerson,
      dietaryTags: r.venue.dietaryTags,
      hours: r.venue.hours,
      indoor: r.venue.indoor,
      rating: r.venue.rating,
      reviewCount: r.venue.reviewCount,
      distanceKm: r.distanceKm,
      walkMinutes: r.walkMinutes,
      description: r.venue.description,
    })),
  };
}

// ---- grounding check --------------------------------------------------------

const money = (n) => Number(n).toFixed(2);

// Returns a list of problems; empty means every checkable fact is grounded.
export function groundingProblems(answer, facts, allVenueNames) {
  const problems = [];
  const cited = facts.candidates;

  const allowedPrices = new Set(
    [...cited.map((c) => c.pricePerPersonUSD), facts.rulesApplied.maxPricePerPersonUSD]
      .filter((n) => n != null)
      .map(money),
  );
  for (const m of answer.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)) {
    if (!allowedPrices.has(money(m[1]))) problems.push(`price $${m[1]} is not in the data`);
  }

  const allowedTimes = new Set(
    [
      ...cited.flatMap((c) => [c.hours.open, c.hours.close]),
      facts.rulesApplied.mustBeOpen?.from,
      facts.rulesApplied.mustBeOpen?.to,
      facts.rulesApplied.nearTo?.startTime,
      facts.rulesApplied.nearTo?.endTime,
    ].filter(Boolean),
  );
  for (const m of answer.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    const t = `${m[1].padStart(2, '0')}:${m[2]}`;
    if (!allowedTimes.has(t)) problems.push(`time ${t} is not in the data`);
  }
  for (const m of answer.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    const t = toHHMM(h * 60 + Number(m[2] || 0));
    if (!allowedTimes.has(t)) problems.push(`time ${m[0]} is not in the data`);
  }

  const candidateNames = new Set(cited.map((c) => c.name.toLowerCase()));
  const anchorName = facts.rulesApplied.nearTo?.name?.toLowerCase();
  const lower = answer.toLowerCase();
  for (const name of allVenueNames) {
    const n = name.toLowerCase();
    if (lower.includes(n) && !candidateNames.has(n) && n !== anchorName) {
      problems.push(`mentions ${name}, which is not a valid candidate`);
    }
  }

  for (const m of answer.matchAll(/\b(\d+)[- ]minute walk/gi)) {
    if (!cited.some((c) => c.walkMinutes === Number(m[1]))) problems.push(`${m[1]}-minute walk is not in the data`);
  }
  return problems;
}

// ---- deterministic answers ---------------------------------------------------

const dietPhrase = (venue, wanted) => {
  const tags = wanted.length ? wanted.filter((t) => venue.dietaryTags.includes(t)) : venue.dietaryTags.slice(0, 2);
  return tags.length ? `${tags.join(' and ')} options` : null;
};

// "a 6-minute walk" but "an 8-", "an 11-", "an 18-", "an 80-89-minute walk"
// (numbers whose spoken form starts with a vowel sound).
export const article = (n) => (n === 8 || n === 11 || n === 18 || (n >= 80 && n <= 89) ? 'an' : 'a');

export function templateAnswer(facts) {
  const [best, ...others] = facts.candidates;
  const rules = facts.rulesApplied;
  const parts = [];
  if (best.walkMinutes != null && rules.nearTo) {
    parts.push(`${best.name} is ${article(best.walkMinutes)} ${best.walkMinutes}-minute walk from ${rules.nearTo.name}`);
  } else {
    parts.push(`${best.name} in ${best.neighborhood} is the best match`);
  }
  const diet = dietPhrase(best, rules.dietaryTags ?? []);
  if (diet) parts.push(`has ${diet}`);
  parts.push(`costs about $${best.pricePerPersonUSD} per person`);
  const alwaysOpen = best.hours.open === '00:00' && best.hours.close === '23:59';
  let text = `${parts.join(', ')}, and ${alwaysOpen ? 'is open 24 hours' : `is open ${best.hours.open}-${best.hours.close}`}.`;
  if (facts.weather && /rain|showers/.test(facts.weather.condition) && best.indoor) {
    text += ` It is indoors, which helps with the ${facts.weather.condition} forecast.`;
  }
  if (others.length) {
    text += ` Other options: ${others
      .slice(0, 2)
      .map((o) => `${o.name} ($${o.pricePerPersonUSD})`)
      .join(' and ')}.`;
  }
  return {
    answer: text,
    suggestedVenueId: best.venueId,
    citedVenueIds: [best.venueId, ...others.slice(0, 2).map((o) => o.venueId)],
  };
}

// When nothing passes: say so, and say which rule ruled out the near misses.
export function noMatchAnswer(constraints, rejected) {
  const pool = rejected.filter((r) => !constraints.category || r.venue.category === constraints.category);
  const counts = {};
  for (const r of pool) for (const rule of Object.keys(r.failures)) counts[rule] = (counts[rule] || 0) + 1;
  const LABEL = {
    budget: 'over budget',
    dietary: 'missing a dietary option',
    hours: 'closed at that time',
    proximity: 'too far away',
  };
  const reasons = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => `${n} ${LABEL[rule]}`);
  const nearMisses = [...pool]
    .sort((a, b) => Object.keys(a.failures).length - Object.keys(b.failures).length || a.venue.pricePerPerson - b.venue.pricePerPerson)
    .slice(0, 3);
  const what = constraints.category ? `${constraints.category} option` : 'venue';
  let answer = `I couldn't find a ${what} that meets every rule.`;
  if (reasons.length) answer += ` Of the ${pool.length} I checked: ${reasons.join(', ')}.`;
  if (nearMisses.length) {
    const m = nearMisses[0];
    answer += ` Closest miss: ${m.venue.name} (${Object.values(m.failures).join('; ')}).`;
  }
  answer += ' Try a higher budget, a different time, or a wider distance.';
  return { answer, nearMisses };
}

// ---- the LLM call ------------------------------------------------------------

export function createLlmClient(config) {
  if (!config.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
}

// Asks Claude to phrase the answer. Resolves with
// { ok: true, reply, model, usage } or { ok: false, reason }.
async function askModel(llm, facts, config) {
  const ids = facts.candidates.map((c) => c.venueId);
  try {
    const response = await llm.beta.messages.create(
      {
        model: config.conciergeModel,
        max_tokens: 2000,
        output_config: { effort: config.conciergeEffort, format: { type: 'json_schema', schema: outputSchema(ids) } },
        // If a safety classifier declines, the API retries on a recommended
        // fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts)}` }],
      },
      { timeout: config.conciergeTimeoutMs, maxRetries: 0 },
    );
    if (response.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (response.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return { ok: false, reason: 'empty_reply' };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    const parsed = replySchema(ids).safeParse(json);
    if (!parsed.success) return { ok: false, reason: 'schema_mismatch' };
    return { ok: true, reply: parsed.data, model: response.model, usage: response.usage };
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, reason: 'timeout' };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, reason: 'rate_limited' };
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, reason: 'bad_api_key' };
    if (err instanceof Anthropic.APIError) {
      // The API's own explanation (e.g. "credit balance is too low"); never contains the key.
      const detail = err.error?.error?.message ?? err.message;
      return { ok: false, reason: `api_error_${err.status ?? 'network'}`, detail: String(detail).slice(0, 300) };
    }
    throw err;
  }
}

// Produces the final reply for a request that has at least one candidate.
export async function writeAnswer({ facts, llm, config, allVenueNames, tripId }) {
  if (!llm) return { ...templateAnswer(facts), mode: 'template', fallbackReason: 'no_api_key' };

  const started = performance.now();
  const result = await askModel(llm, facts, config);
  const llmMs = Math.round(performance.now() - started);

  if (result.ok) {
    const problems = groundingProblems(result.reply.answer, facts, allVenueNames);
    const cited = [...new Set([result.reply.suggestedVenueId, ...result.reply.citedVenueIds])];
    if (!problems.length) {
      return { ...result.reply, citedVenueIds: cited, mode: 'llm', model: result.model, llmMs, usage: result.usage };
    }
    log.warn('concierge.ungrounded', { tripId, problems });
    return { ...templateAnswer(facts), mode: 'template', fallbackReason: 'ungrounded', problems, llmMs };
  }
  log.warn('concierge.llm_fallback', { tripId, reason: result.reason, detail: result.detail, llmMs });
  return { ...templateAnswer(facts), mode: 'template', fallbackReason: result.reason, llmMs };
}
