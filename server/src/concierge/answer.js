import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toHHMM } from './constraints.js';
import { log } from '../lib/logger.js';
import { amountsIn, formatMoney, CURRENCIES, DEFAULT_CURRENCY } from '../lib/money.js';

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
- Write prices exactly as given, with the currency symbol from the facts (for example ₹450 or $22). Write times as HH:MM in 24-hour form exactly as given.
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
  const currency = constraints.currency ?? DEFAULT_CURRENCY;
  return {
    question,
    currency,
    currencySymbol: CURRENCIES[currency]?.symbol ?? currency,
    rulesApplied: {
      category: constraints.category,
      maxPricePerPerson: constraints.maxPricePerPerson,
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
      pricePerPerson: r.venue.pricePerPerson,
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
    [...cited.map((c) => c.pricePerPerson), facts.rulesApplied.maxPricePerPerson]
      .filter((n) => n != null)
      .map(money),
  );
  for (const { raw, value } of amountsIn(answer)) {
    if (!allowedPrices.has(money(value))) problems.push(`price ${raw} is not in the data`);
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
  parts.push(`costs about ${formatMoney(best.pricePerPerson, facts.currency)} per person`);
  const alwaysOpen = best.hours.open === '00:00' && best.hours.close === '23:59';
  let text = `${parts.join(', ')}, and ${alwaysOpen ? 'is open 24 hours' : `is open ${best.hours.open}-${best.hours.close}`}.`;
  if (facts.weather && /rain|showers/.test(facts.weather.condition) && best.indoor) {
    text += ` It is indoors, which helps with the ${facts.weather.condition} forecast.`;
  }
  if (others.length) {
    text += ` Other options: ${others
      .slice(0, 2)
      .map((o) => `${o.name} (${formatMoney(o.pricePerPerson, facts.currency)})`)
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

// Which model writes the wording (CONCIERGE_PROVIDER):
//   auto      Claude if ANTHROPIC_API_KEY is set, otherwise the template (default)
//   anthropic Claude via the Anthropic API (paid)
//   ollama    a local open-source model through Ollama (free, runs on this machine)
//   none      always the template
export function resolveProvider(config) {
  const p = config.conciergeProvider ?? 'auto';
  if (p === 'auto') return config.anthropicApiKey ? 'anthropic' : 'none';
  return p;
}

export function createLlmClient(config) {
  const provider = resolveProvider(config);
  if (provider === 'anthropic') {
    if (!config.anthropicApiKey) return null;
    return new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
  }
  if (provider === 'ollama') {
    return { provider: 'ollama', baseUrl: config.ollamaUrl.replace(/\/$/, ''), model: config.ollamaModel };
  }
  return null;
}

// Short label for health checks and logs.
export const providerLabel = (llm) =>
  !llm ? 'template' : llm.provider === 'ollama' ? `ollama:${llm.model}` : 'claude';

// Checks a model's JSON reply against the candidate ids.
function parseReply(text, ids) {
  if (!text) return { ok: false, reason: 'empty_reply' };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const parsed = replySchema(ids).safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'schema_mismatch' };
  return { ok: true, reply: parsed.data };
}

const userMessage = (facts) => `Facts (JSON):\n${JSON.stringify(facts)}`;

// A small local model on a CPU spends most of its time reading the prompt, so
// it gets a shorter version: the top 3 candidates and only the fields an
// answer needs. (The grounding check still uses the full facts.)
export function compactFacts(facts) {
  const r = facts.rulesApplied;
  return {
    question: facts.question,
    currencySymbol: facts.currencySymbol,
    near: r.nearTo?.name ?? null,
    weather: facts.weather ? facts.weather.condition : null,
    candidates: facts.candidates.slice(0, 3).map((c) => ({
      venueId: c.venueId,
      name: c.name,
      area: c.neighborhood,
      price: c.pricePerPerson,
      dietary: c.dietaryTags,
      open: `${c.hours.open}-${c.hours.close}`,
      walkMinutes: c.walkMinutes,
      rating: c.rating,
    })),
  };
}

const SYSTEM_SHORT = `You write one reply for a trip-planning app. Use ONLY the candidates given; they all fit the group's rules and the first is the best match.
Reply as JSON: "answer" is two plain sentences recommending one candidate by name, mentioning its price with the currency symbol given (like ₹450) and why it fits; "suggestedVenueId" is that candidate's venueId; "citedVenueIds" lists every venueId you mention. Never invent prices, times or places.`;

// Rejects replies that are technically grounded but not a real answer
// (a bare name, or the JSON leaking into the sentence).
export function qualityProblems(answer, suggested) {
  const problems = [];
  if (answer.trim().split(/\s+/).length < 8) problems.push('answer is too short');
  if (/venueId|citedVenueIds|suggestedVenueId|[{}[\]=]/.test(answer)) problems.push('answer contains raw data');
  if (suggested && !answer.toLowerCase().includes(suggested.name.toLowerCase())) problems.push('answer does not name the suggestion');
  return problems;
}

// Local model through Ollama's chat API. `format` takes a JSON schema, so the
// reply is constrained to the same shape (and the same candidate ids) as Claude's.
async function askOllama(llm, facts, config) {
  const ids = facts.candidates.slice(0, 3).map((c) => c.venueId);
  let res;
  try {
    res = await fetch(`${llm.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llm.model,
        stream: false,
        format: outputSchema(ids),
        keep_alive: '30m', // keep the model in memory between questions
        options: { temperature: 0, num_predict: 160 },
        messages: [
          { role: 'system', content: SYSTEM_SHORT },
          { role: 'user', content: JSON.stringify(compactFacts(facts)) },
        ],
      }),
      signal: AbortSignal.timeout(config.conciergeTimeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'llm_unavailable', detail: `Ollama not reachable at ${llm.baseUrl}` };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    return { ok: false, reason: `ollama_error_${res.status}`, detail };
  }
  const body = await res.json();
  if (body.done_reason === 'length') return { ok: false, reason: 'max_tokens' };
  const parsed = parseReply(body.message?.content, ids);
  if (!parsed.ok) return parsed;
  return {
    ...parsed,
    model: `ollama/${body.model ?? llm.model}`,
    usage: { input_tokens: body.prompt_eval_count, output_tokens: body.eval_count },
  };
}

// Loads the local model into memory at startup, so the first question isn't
// slowed down by loading it from disk. Never throws.
export async function warmUp(llm) {
  if (llm?.provider !== 'ollama') return null;
  const started = performance.now();
  try {
    const res = await fetch(`${llm.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llm.model, stream: false, keep_alive: '30m', messages: [{ role: 'user', content: 'ok' }], options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Math.round(performance.now() - started);
    if (!res.ok) log.warn('concierge.warmup_failed', { model: llm.model, status: res.status, detail: (await res.text()).slice(0, 200) });
    else log.info('concierge.warmup', { model: llm.model, ms });
    return ms;
  } catch (err) {
    log.warn('concierge.warmup_failed', { model: llm.model, error: err.message });
    return null;
  }
}

// Asks the model to phrase the answer. Resolves with
// { ok: true, reply, model, usage } or { ok: false, reason, detail? }.
async function askModel(llm, facts, config) {
  if (llm.provider === 'ollama') return askOllama(llm, facts, config);
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
        messages: [{ role: 'user', content: userMessage(facts) }],
      },
      { timeout: config.conciergeTimeoutMs, maxRetries: 0 },
    );
    if (response.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (response.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
    const parsed = parseReply(response.content.find((b) => b.type === 'text')?.text, ids);
    if (!parsed.ok) return parsed;
    return { ...parsed, model: response.model, usage: response.usage };
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
  if (!llm) return { ...templateAnswer(facts), mode: 'template', fallbackReason: config.conciergeProvider === 'none' ? 'template_only' : 'no_api_key' };

  const started = performance.now();
  const result = await askModel(llm, facts, config);
  const llmMs = Math.round(performance.now() - started);

  if (result.ok) {
    // 1. Truth first: every fact it states must be in the data.
    const problems = groundingProblems(result.reply.answer, facts, allVenueNames);
    if (problems.length) {
      log.warn('concierge.ungrounded', { tripId, problems });
      return { ...templateAnswer(facts), mode: 'template', fallbackReason: 'ungrounded', problems, llmMs };
    }
    // 2. Then usefulness: a real sentence that names the suggestion.
    const suggested = facts.candidates.find((c) => c.venueId === result.reply.suggestedVenueId);
    const weak = qualityProblems(result.reply.answer, suggested);
    if (weak.length) {
      log.warn('concierge.low_quality', { tripId, problems: weak });
      return { ...templateAnswer(facts), mode: 'template', fallbackReason: 'low_quality', problems: weak, llmMs };
    }
    const cited = [...new Set([result.reply.suggestedVenueId, ...result.reply.citedVenueIds])];
    return { ...result.reply, citedVenueIds: cited, mode: 'llm', model: result.model, llmMs, usage: result.usage };
  }
  log.warn('concierge.llm_fallback', { tripId, reason: result.reason, detail: result.detail, llmMs });
  return { ...templateAnswer(facts), mode: 'template', fallbackReason: result.reason, llmMs };
}
