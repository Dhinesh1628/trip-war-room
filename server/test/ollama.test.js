import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { DATA_DIR } from '../src/venues/seedData.js';
import { FIXTURE_DIR } from './fixtures.js';
import { createLlmClient, resolveProvider, providerLabel, writeAnswer, factsFor, qualityProblems, compactFacts } from '../src/concierge/answer.js';
import { loadConfig } from '../src/config/env.js';
import { filterCandidates, rankCandidates } from '../src/concierge/constraints.js';

// The free local-model path: a fake Ollama server stands in for the real one.

let venues;
let fakeOllama;
let url;
let handler; // (body, res) => void, set per test
const seen = [];

beforeAll(async () => {
  venues = JSON.parse(await readFile(`${FIXTURE_DIR}/lisbon.json`, 'utf8')).venues;
  fakeOllama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ path: req.url, body });
      handler(body, res);
    });
  });
  await new Promise((r) => fakeOllama.listen(0, r));
  url = `http://localhost:${fakeOllama.address().port}`;
});

afterAll(() => new Promise((r) => fakeOllama.close(r)));

const reply = (res, content, extra = {}) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'llama3.2:3b', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 812, eval_count: 41, ...extra }));
};

function facts() {
  const c = { category: 'dinner', maxPricePerPerson: 25, dietaryTags: ['vegetarian'], slot: null, anchor: null, radiusKm: 2, excludeVenueIds: [] };
  const ranked = rankCandidates(filterCandidates(venues, c).valid, c);
  return factsFor({ question: 'vegetarian dinner under $25', constraints: c, ranked, weather: null });
}

const config = (over = {}) => ({
  conciergeProvider: 'ollama',
  ollamaUrl: url,
  ollamaModel: 'llama3.2:3b',
  conciergeTimeoutMs: 500,
  ...over,
});
const names = () => venues.map((v) => v.name);

describe('choosing the provider', () => {
  test.each([
    [{ conciergeProvider: 'auto', anthropicApiKey: 'sk-ant-x' }, 'anthropic'],
    [{ conciergeProvider: 'auto', anthropicApiKey: null }, 'none'],
    [{ conciergeProvider: 'ollama', anthropicApiKey: 'sk-ant-x' }, 'ollama'],
    [{ conciergeProvider: 'none', anthropicApiKey: 'sk-ant-x' }, 'none'],
  ])('%j -> %s', (cfg, expected) => {
    expect(resolveProvider(cfg)).toBe(expected);
  });

  test('labels for the health check', () => {
    expect(providerLabel(null)).toBe('template');
    expect(providerLabel(createLlmClient(config()))).toBe('ollama:llama3.2:3b');
  });
});

describe('quality check and short prompt', () => {
  const best = { name: 'Horta Verde' };
  test.each([
    ['Horta Verde', 'answer is too short'],
    ['citedVenueIds = ["v_lis_002"]; Horta Verde is a good option for dinner tonight', 'answer contains raw data'],
    ['A lovely plant-based kitchen with great food, about $18 per person.', 'answer does not name the suggestion'],
  ])('rejects %j', (answer, problem) => {
    expect(qualityProblems(answer, best)).toContain(problem);
  });

  test('accepts a real recommendation', () => {
    expect(qualityProblems('Horta Verde is a great vegetarian dinner at $18 per person, close to the tour.', best)).toEqual([]);
  });

  test('the local model gets only the top 3 candidates and the fields it needs', () => {
    const c = compactFacts(facts());
    expect(c.candidates).toHaveLength(3);
    expect(Object.keys(c.candidates[0]).sort()).toEqual(['area', 'dietary', 'name', 'open', 'price', 'rating', 'venueId', 'walkMinutes']);
  });

  test('a local model gets a 20 s default time limit, Claude 2.5 s', () => {
    const base = { MONGO_URI: 'x', JWT_SECRET: 'y'.repeat(32) };
    expect(loadConfig({ ...base, CONCIERGE_PROVIDER: 'ollama' }).conciergeTimeoutMs).toBe(20000);
    expect(loadConfig(base).conciergeTimeoutMs).toBe(2500);
    expect(loadConfig({ ...base, CONCIERGE_PROVIDER: 'ollama', CONCIERGE_TIMEOUT_MS: '9000' }).conciergeTimeoutMs).toBe(9000);
  });
});

describe('Ollama answers', () => {
  test('a grounded local reply is used, and the request is constrained to the candidates', async () => {
    const f = facts();
    const best = f.candidates[0];
    handler = (body, res) =>
      reply(res, JSON.stringify({ answer: `${best.name} has vegetarian options and costs about $${best.pricePerPerson} per person.`, suggestedVenueId: best.venueId, citedVenueIds: [best.venueId] }));
    const out = await writeAnswer({ facts: f, llm: createLlmClient(config()), config: config(), allVenueNames: names() });
    expect(out).toMatchObject({ mode: 'llm', model: 'ollama/llama3.2:3b', suggestedVenueId: best.venueId, usage: { input_tokens: 812, output_tokens: 41 } });

    const { path, body } = seen.at(-1);
    expect(path).toBe('/api/chat');
    expect(body).toMatchObject({ model: 'llama3.2:3b', stream: false, keep_alive: '30m', options: { temperature: 0 } });
    // The local model only sees (and may only pick) the top 3 candidates.
    expect(body.format.properties.suggestedVenueId.enum).toEqual(f.candidates.slice(0, 3).map((c) => c.venueId));
    expect(body.messages[0].role).toBe('system');
  });

  test.each([
    ['a venue outside the candidates', (res) => reply(res, JSON.stringify({ answer: 'x', suggestedVenueId: 'v_lis_007', citedVenueIds: ['v_lis_007'] })), 'schema_mismatch'],
    ['an invented price', (res, f) => reply(res, JSON.stringify({ answer: `${f.candidates[0].name} costs $2.`, suggestedVenueId: f.candidates[0].venueId, citedVenueIds: [f.candidates[0].venueId] })), 'ungrounded'],
    ['text that is not JSON', (res) => reply(res, 'Sure! Try Horta Verde.'), 'invalid_json'],
    ['a cut-off reply', (res) => reply(res, '{"answer": "Hor', { done_reason: 'length' }), 'max_tokens'],
    ['an Ollama error (model not pulled)', (res) => { res.writeHead(404); res.end('{"error":"model \\"llama3.2:3b\\" not found"}'); }, 'ollama_error_404'],
    ['a reply slower than the time limit', (res) => setTimeout(() => reply(res, '{}'), 1500), 'timeout'],
  ])('falls back to the template on %s', async (_label, respond, reason) => {
    const f = facts();
    handler = (body, res) => respond(res, f);
    const out = await writeAnswer({ facts: f, llm: createLlmClient(config()), config: config(), allVenueNames: names() });
    expect(out).toMatchObject({ mode: 'template', fallbackReason: reason, suggestedVenueId: f.candidates[0].venueId });
  });

  test('falls back to the template when Ollama is not running', async () => {
    const down = config({ ollamaUrl: 'http://localhost:1' });
    const out = await writeAnswer({ facts: facts(), llm: createLlmClient(down), config: down, allVenueNames: names() });
    expect(out).toMatchObject({ mode: 'template', fallbackReason: 'llm_unavailable' });
  });
});
