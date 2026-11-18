import Anthropic from '@anthropic-ai/sdk';
import { parseQuestion, buildConstraints, resolveAnchor } from '../src/concierge/interpret.js';
import { factsFor, groundingProblems, templateAnswer, noMatchAnswer, writeAnswer } from '../src/concierge/answer.js';
import { filterCandidates, rankCandidates } from '../src/concierge/constraints.js';
import { detectConflicts, diffConflicts, travelMinutes } from '../src/concierge/conflicts.js';
import { openVote, castBallot, resolveVote, cancelVote, tallyOf, shareASlot } from '../src/board/votes.js';
import { readFile } from 'node:fs/promises';
import { DATA_DIR } from '../src/venues/seedData.js';

let venues;
let byId;
beforeAll(async () => {
  venues = JSON.parse(await readFile(`${DATA_DIR}/lisbon.json`, 'utf8')).venues;
  byId = new Map(venues.map((v) => [v.venueId, v]));
});

const item = (id, venueId, dayIndex, startTime, endTime, extra = {}) => ({
  itemId: id,
  _id: id,
  venueId,
  venue: byId.get(venueId),
  dayIndex,
  startTime,
  endTime,
  lifecycleStage: 'drafting',
  positionVersion: 1,
  createdAt: new Date(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, '')) || 0),
  ...extra,
});

const BUDGET = { totalBudget: 1200, participantCount: 4, perPersonCommitted: 0, remaining: 1200 };

describe('reading the question', () => {
  test('the spec example', () => {
    expect(parseQuestion('Suggest a dinner spot near our 5 PM tour under $25/person')).toEqual({
      category: 'dinner',
      dietaryTags: [],
      maxPricePerPerson: 25,
      radiusKm: null,
      dayIndex: null,
      time: null,
      anchorRef: { relation: 'near', time: 17 * 60, noun: 'tour' },
    });
  });

  test.each([
    ['vegan lunch at 1pm within 500 m', { category: 'lunch', dietaryTags: ['vegan'], time: 780, radiusKm: 0.5 }],
    ['gluten free breakfast before our Belem tower visit', { category: 'breakfast', dietaryTags: ['gluten-free'] }],
    ['hotel under 80 on day 2', { category: 'lodging', maxPricePerPerson: 80, dayIndex: 1 }],
    ['halal and nut-free dinner at 19:45', { category: 'dinner', dietaryTags: ['halal', 'nut-free'], time: 19 * 60 + 45 }],
    ['coffee near the castle', { category: 'cafe' }],
    ['something plant based, max $15', { dietaryTags: ['vegan'], maxPricePerPerson: 15 }],
  ])('%s', (q, expected) => {
    expect(parseQuestion(q)).toMatchObject(expected);
  });

  test('the anchor phrase is found on the board by time, then by name (accents ignored)', () => {
    const items = [
      item('i1', 'v_lis_025', 0, '17:00', '19:00'), // Alfama tour
      item('i2', 'v_lis_029', 1, '10:00', '11:00'), // Belém tower
    ];
    expect(resolveAnchor(items, { time: 17 * 60, noun: 'tour' }).itemId).toBe('i1');
    expect(resolveAnchor(items, { time: null, noun: 'belem tower visit' }).itemId).toBe('i2');
    expect(resolveAnchor(items, { time: null, noun: 'spaceship' })).toBeNull();
  });

  test('constraints: slot starts 30 min after the anchor ends; budget from the question', () => {
    const items = [item('i1', 'v_lis_025', 0, '17:00', '19:00')];
    const c = buildConstraints('dinner near our 5 PM tour under $25', {
      items,
      travellers: new Map(),
      participantIds: [],
      requesterId: 'u1',
      budget: BUDGET,
    });
    expect(c).toMatchObject({ category: 'dinner', maxPricePerPerson: 25, budgetSource: 'question', radiusKm: 2, dayIndex: 0 });
    expect(c.slot).toMatchObject({ start: 19 * 60 + 30, end: 21 * 60 });
    expect(c.anchor).toMatchObject({ itemId: 'i1', name: 'Alfama Old Quarter Walking Tour' });
    expect(c.excludeVenueIds).toEqual(['v_lis_025']);
  });

  test('"before" puts the slot before the anchor starts', () => {
    const items = [item('i1', 'v_lis_029', 1, '10:00', '11:00')];
    const c = buildConstraints('breakfast before our belem tower visit', {
      items, travellers: new Map(), participantIds: [], requesterId: 'u', budget: BUDGET,
    });
    expect(c.slot).toMatchObject({ start: 8 * 60 + 45, end: 9 * 60 + 30 }); // 45 min breakfast ending 30 min before 10:00
  });

  test('budget falls back to my remaining budget, then the group per-person remaining budget', () => {
    const ctx = (travellers) => ({
      items: [],
      travellers,
      participantIds: [...travellers.keys()],
      requesterId: 'me',
      budget: { totalBudget: 1000, participantCount: 4, perPersonCommitted: 50, remaining: 800 },
    });
    expect(buildConstraints('dinner', ctx(new Map([['me', { dietaryTags: [], budgetCeiling: 120 }]])))).toMatchObject({
      maxPricePerPerson: 70,
      budgetSource: 'your remaining budget',
    });
    expect(buildConstraints('dinner', ctx(new Map([['me', { dietaryTags: [], budgetCeiling: null }]])))).toMatchObject({
      maxPricePerPerson: 200,
      budgetSource: "the group's remaining budget per person",
    });
  });

  test("everyone's declared dietary needs apply, plus the question's", () => {
    const travellers = new Map([
      ['a', { dietaryTags: ['halal'], budgetCeiling: null }],
      ['b', { dietaryTags: ['vegetarian'], budgetCeiling: null }],
    ]);
    const c = buildConstraints('gluten free dinner', {
      items: [], travellers, participantIds: ['a', 'b'], requesterId: 'a', budget: BUDGET,
    });
    expect(c.dietaryTags).toEqual(['gluten-free', 'halal', 'vegetarian']);
  });

  test('explicit fields override the text; an unknown anchor item is a 404', () => {
    const ctx = { items: [], travellers: new Map(), participantIds: [], requesterId: 'u', budget: BUDGET };
    expect(buildConstraints('dinner under $25', ctx, { maxPricePerPerson: 40, category: 'lunch' })).toMatchObject({
      maxPricePerPerson: 40,
      category: 'lunch',
    });
    expect(() => buildConstraints('dinner', ctx, { anchorItemId: '64b7f0f0f0f0f0f0f0f0f0f0' })).toThrow(/anchorItemId/);
  });
});

// ---- answers ------------------------------------------------------------------

function exampleFacts() {
  const items = [item('i1', 'v_lis_025', 0, '17:00', '19:00')];
  const constraints = buildConstraints('Suggest a dinner spot near our 5 PM tour under $25/person', {
    items, travellers: new Map(), participantIds: [], requesterId: 'u', budget: BUDGET,
  });
  const ranked = rankCandidates(filterCandidates(venues, constraints).valid, constraints);
  return factsFor({ question: 'q', constraints, ranked, weather: { condition: 'rain', highC: 14, lowC: 9 } });
}

describe('grounded answers', () => {
  test('the template answer only uses supplied facts', () => {
    const facts = exampleFacts();
    const t = templateAnswer(facts);
    expect(t.suggestedVenueId).toBe(facts.candidates[0].venueId);
    expect(groundingProblems(t.answer, facts, venues.map((v) => v.name))).toEqual([]);
    expect(t.answer).toMatch(/-minute walk from Alfama Old Quarter Walking Tour/);
    expect(t.answer).toMatch(/\$\d+ per person/);
  });

  test.each([
    ['an invented price', (best) => `${best.name} costs $9 per person.`],
    ['an invented time', (best) => `${best.name} opens at 06:15.`],
    ['an invented 12-hour time', (best) => `${best.name} is open until 4 am.`],
    ['a venue that failed the rules', () => 'Try Alma Lusa Degustação instead.'],
    ['an invented walking time', (best) => `${best.name} is a 42-minute walk away.`],
  ])('the grounding check catches %s', (_label, make) => {
    const facts = exampleFacts();
    const problems = groundingProblems(make(facts.candidates[0]), facts, venues.map((v) => v.name));
    expect(problems.length).toBeGreaterThan(0);
  });

  test('no match: the decline says why, and names the closest miss', () => {
    const constraints = { category: 'dinner', maxPricePerPerson: 5, dietaryTags: [], slot: null, anchor: null, radiusKm: 2 };
    const { rejected } = filterCandidates(venues, constraints);
    const { answer, nearMisses } = noMatchAnswer(constraints, rejected);
    expect(answer).toMatch(/couldn't find a dinner option/);
    expect(answer).toMatch(/over budget/);
    expect(nearMisses.length).toBeGreaterThan(0);
  });
});

// A fake Anthropic client. `reply` decides what it answers.
function fakeLlm(reply) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params, options) => {
          calls.push({ params, options });
          return reply(params);
        },
      },
    },
  };
}
const CONFIG = { conciergeModel: 'claude-opus-5-5', conciergeEffort: 'low', conciergeTimeoutMs: 2500 };
const ok = (json) => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: 900, output_tokens: 60 } });

describe('the Claude call', () => {
  test('a grounded reply is used, and the request is shaped correctly', async () => {
    const facts = exampleFacts();
    const best = facts.candidates[0];
    const llm = fakeLlm(() =>
      ok({ answer: `${best.name} is a ${best.walkMinutes}-minute walk from the tour and costs $${best.pricePerPersonUSD}.`, suggestedVenueId: best.venueId, citedVenueIds: [best.venueId] }),
    );
    const out = await writeAnswer({ facts, llm, config: CONFIG, allVenueNames: venues.map((v) => v.name) });
    expect(out).toMatchObject({ mode: 'llm', suggestedVenueId: best.venueId, model: 'claude-opus-5-5' });

    const { params, options } = llm.calls[0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.output_config.effort).toBe('low');
    expect(params.output_config.format.type).toBe('json_schema');
    // The model can only pick from the candidates.
    expect(params.output_config.format.schema.properties.suggestedVenueId.enum).toEqual(facts.candidates.map((c) => c.venueId));
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.thinking).toBeUndefined(); // can't be disabled on this model; effort controls it
    expect(options).toEqual({ timeout: 2500, maxRetries: 0 });
  });

  test.each([
    ['a venue id outside the candidates', (f) => ok({ answer: 'x', suggestedVenueId: 'v_lis_007', citedVenueIds: ['v_lis_007'] }), 'schema_mismatch'],
    ['a made-up price', (f) => ok({ answer: `${f.candidates[0].name} is only $3.`, suggestedVenueId: f.candidates[0].venueId, citedVenueIds: [f.candidates[0].venueId] }), 'ungrounded'],
    ['a refusal', () => ({ stop_reason: 'refusal', content: [], model: 'claude-opus-5-5' }), 'refusal'],
    ['a cut-off reply', () => ({ stop_reason: 'max_tokens', content: [], model: 'claude-opus-5-5' }), 'max_tokens'],
    ['text that is not JSON', () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sure!' }], model: 'm' }), 'invalid_json'],
  ])('falls back to the template on %s', async (_label, reply, reason) => {
    const facts = exampleFacts();
    const out = await writeAnswer({ facts, llm: fakeLlm(() => reply(facts)), config: CONFIG, allVenueNames: venues.map((v) => v.name) });
    expect(out).toMatchObject({ mode: 'template', fallbackReason: reason, suggestedVenueId: facts.candidates[0].venueId });
  });

  test.each([
    ['a timeout', () => new Anthropic.APIConnectionTimeoutError(), 'timeout'],
    ['a connection error', () => new Anthropic.APIConnectionError({ message: 'down' }), 'api_error_network'],
  ])('falls back to the template on %s', async (_label, makeError, reason) => {
    const facts = exampleFacts();
    const llm = fakeLlm(() => {
      throw makeError();
    });
    const out = await writeAnswer({ facts, llm, config: CONFIG, allVenueNames: venues.map((v) => v.name) });
    expect(out).toMatchObject({ mode: 'template', fallbackReason: reason });
  });

  test('with no API key the template is used and nothing is called', async () => {
    const out = await writeAnswer({ facts: exampleFacts(), llm: null, config: CONFIG, allVenueNames: [] });
    expect(out).toMatchObject({ mode: 'template', fallbackReason: 'no_api_key' });
  });
});

// ---- conflict detector ---------------------------------------------------------

describe('conflict detector', () => {
  const base = { participantIds: ['a', 'b'], travellers: new Map(), totalBudget: 1000 };

  test('time overlap on the same day', () => {
    const items = [item('i1', 'v_lis_027', 0, '10:00', '11:30'), item('i2', 'v_lis_026', 0, '11:00', '12:00')];
    const [c] = detectConflicts({ ...base, items }).filter((x) => x.conflictType === 'overlap');
    expect(c).toMatchObject({ conflictType: 'overlap', itemIds: ['i1', 'i2'], details: { reason: 'time', dayIndex: 0 } });
  });

  test('same times on different days are fine', () => {
    const items = [item('i1', 'v_lis_027', 0, '10:00', '11:30'), item('i2', 'v_lis_026', 1, '10:00', '11:30')];
    expect(detectConflicts({ ...base, items })).toEqual([]);
  });

  test('not enough time to travel between consecutive items', () => {
    // Alfama castle until 12:00, then Belém tower (about 7 km away) at 12:05.
    const items = [item('i1', 'v_lis_027', 0, '10:00', '12:00'), item('i2', 'v_lis_029', 0, '12:05', '13:00')];
    const [c] = detectConflicts({ ...base, items });
    expect(c).toMatchObject({ conflictType: 'overlap', details: { reason: 'travel', gapMinutes: 5 } });
    expect(c.details.travelMinutes).toBe(travelMinutes(byId.get('v_lis_027').coordinates, byId.get('v_lis_029').coordinates));
  });

  test('a venue scheduled while it is closed', () => {
    const items = [item('i1', 'v_lis_010', 0, '19:00', '20:00')]; // lunch-only canteen
    expect(detectConflicts({ ...base, items })[0]).toMatchObject({ conflictType: 'hours', itemIds: ['i1'] });
  });

  test("budget breach names the traveller and the item that pushed them over", () => {
    const travellers = new Map([['a', { budgetCeiling: 60, dietaryTags: [] }]]);
    const items = [
      item('i1', 'v_lis_001', 0, '12:00', '13:00'), // $22
      item('i2', 'v_lis_004', 0, '19:00', '21:00'), // $48 -> 70 > 60
    ];
    const breach = detectConflicts({ ...base, travellers, items }).find((c) => c.conflictType === 'budgetBreach');
    expect(breach).toMatchObject({ conflictId: 'budget:traveller:a', itemIds: ['i2'], details: { scope: 'traveller', ceiling: 60, committed: 70, over: 10 } });
  });

  test('group budget breach', () => {
    const items = [item('i1', 'v_lis_041', 0, '15:00', '16:00')]; // $215 x 2 travellers
    const c = detectConflicts({ ...base, totalBudget: 400, items }).find((x) => x.conflictId === 'budget:group');
    expect(c.details).toMatchObject({ committed: 430, over: 30 });
  });

  test('diff reports what opened and what was resolved', () => {
    const a = [{ conflictId: 'x' }, { conflictId: 'y' }];
    const b = [{ conflictId: 'y' }, { conflictId: 'z' }];
    expect(diffConflicts(a, b)).toEqual({ opened: [{ conflictId: 'z' }], resolved: [{ conflictId: 'x' }] });
  });
});

// ---- voting --------------------------------------------------------------------

describe('contested-slot voting', () => {
  const board = () =>
    new Map([
      ['i1', item('i1', 'v_lis_001', 0, '19:00', '20:30')],
      ['i2', item('i2', 'v_lis_002', 0, '19:30', '21:00')],
      ['i3', item('i3', 'v_lis_003', 1, '19:00', '20:30')],
    ]);
  const open = (items, ids = ['i1', 'i2']) => openVote(items, { voteId: 'vote1', itemIds: ids, openedByUserId: 'leader', closesAt: new Date(Date.now() + 60000) });

  test('only items competing for the same slot can be put to a vote', () => {
    const items = board();
    expect(shareASlot([items.get('i1'), items.get('i2')])).toBe(true);
    expect(open(items, ['i1', 'i3']).code).toBe('NOT_CONTESTED');
    expect(open(items, ['i1']).code).toBe('VOTE_NEEDS_TWO');
    expect(open(items, ['i1', 'nope']).code).toBe('ITEM_NOT_FOUND');
  });

  test('opening a vote puts the items into the voting stage', () => {
    const items = board();
    const r = open(items);
    expect(r.ok).toBe(true);
    expect(items.get('i1')).toMatchObject({ lifecycleStage: 'voting', positionVersion: 2 });
    expect(open(items).code).toBe('ITEM_IN_VOTE');
  });

  test('one ballot per traveller; voting again changes it', () => {
    const items = board();
    const { vote } = open(items);
    expect(castBallot(vote, { userId: 'a', itemId: 'i1' })).toEqual({ ok: true, changed: false });
    expect(castBallot(vote, { userId: 'a', itemId: 'i2' })).toEqual({ ok: true, changed: true });
    expect(castBallot(vote, { userId: 'a', itemId: 'i3' }).code).toBe('NOT_A_CANDIDATE');
    expect(tallyOf(vote)).toEqual({ i1: 0, i2: 1 });
  });

  test('the winner is locked in place and the other option leaves the board', () => {
    const items = board();
    const { vote } = open(items);
    castBallot(vote, { userId: 'a', itemId: 'i2' });
    castBallot(vote, { userId: 'b', itemId: 'i2' });
    castBallot(vote, { userId: 'c', itemId: 'i1' });
    const r = resolveVote(items, vote);
    expect(r).toMatchObject({ ok: true, resolution: 'votes', tally: { i1: 1, i2: 2 } });
    expect(items.get('i2')).toMatchObject({ lifecycleStage: 'locked', startTime: '19:30', positionVersion: 3 });
    expect(items.has('i1')).toBe(false);
    expect(resolveVote(items, vote).code).toBe('VOTE_CLOSED');
  });

  test('a tie, or no votes, goes to the item pinned first', () => {
    for (const ballots of [[['a', 'i1'], ['b', 'i2']], []]) {
      const items = board();
      const { vote } = open(items);
      for (const [userId, itemId] of ballots) castBallot(vote, { userId, itemId });
      const r = resolveVote(items, vote);
      expect(r.winner.itemId).toBe('i1');
      expect(r.resolution).toBe(ballots.length ? 'tie_earliest_pin' : 'no_votes_earliest_pin');
    }
  });

  test('cancelling puts everything back to drafting', () => {
    const items = board();
    const { vote } = open(items);
    expect(cancelVote(items, vote).ok).toBe(true);
    expect(items.get('i1').lifecycleStage).toBe('drafting');
    expect(items.get('i2').lifecycleStage).toBe('drafting');
  });
});
