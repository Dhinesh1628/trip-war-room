import { DEFAULT_CURRENCY } from '../lib/money.js';
// The budget engine (spec 6, 11.1 week 3, 13: "100%-accurate per-person
// totals"). Pure functions, integer cents only, so every total is exact:
// the shares of an item always add up to exactly the item's cost, and the
// per-person totals always add up to exactly the group total.
//
// An item's cost = venue price per person x number of people attending.
// It is then split among the attendees:
//   even      equal shares
//   weighted  shares proportional to whole-number weights (e.g. 2:1:1 for a
//             bigger room)
// Leftover cents from rounding go to the people with the largest remainders,
// ties to the lower user id (the "largest remainder" method), so the result
// is deterministic and nobody is ever off by more than one cent.

export const toCents = (dollars) => Math.round(Number(dollars) * 100);
export const fromCents = (cents) => cents / 100;

// Splits `totalCents` among `people` in proportion to integer `weights`.
// Returns a Map userId -> cents whose values sum to exactly totalCents.
export function splitCents(totalCents, people, weights = null) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error('totalCents must be a non-negative integer');
  const ids = [...people].map(String).sort();
  if (!ids.length) return new Map();
  const w = ids.map((id) => (weights ? Number(weights[id] ?? 0) : 1));
  if (w.some((x) => !Number.isInteger(x) || x < 0)) throw new Error('weights must be whole numbers >= 0');
  const W = w.reduce((a, b) => a + b, 0);
  if (W === 0) throw new Error('at least one weight must be above zero');

  // Exact integer arithmetic: floor(total * w / W), remainder (total * w) % W.
  const base = ids.map((id, i) => ({ id, cents: Math.floor((totalCents * w[i]) / W), rem: (totalCents * w[i]) % W }));
  let leftover = totalCents - base.reduce((s, b) => s + b.cents, 0);
  const order = [...base].sort((a, b) => b.rem - a.rem || a.id.localeCompare(b.id));
  for (const b of order) {
    if (leftover === 0) break;
    if (b.rem === 0 && w[ids.indexOf(b.id)] === 0) continue; // a zero weight never gets a cent
    b.cents += 1;
    leftover -= 1;
  }
  return new Map(base.map((b) => [b.id, b.cents]));
}

// Who attends an item: its attendeeIds if set, otherwise everyone in the trip
// (only current participants count).
export function attendeesOf(item, participantIds) {
  const everyone = participantIds.map(String);
  const listed = (item.attendeeIds ?? []).map(String).filter((id) => everyone.includes(id));
  return listed.length ? listed : everyone;
}

export function itemCost(item, participantIds) {
  const attendees = attendeesOf(item, participantIds);
  const totalCents = toCents(item.venue?.pricePerPerson ?? 0) * attendees.length;
  const split = item.split?.type === 'weighted' ? item.split : { type: 'even' };
  const weights = split.type === 'weighted' ? Object.fromEntries(attendees.map((id) => [id, split.weights?.[id] ?? 1])) : null;
  return { attendees, totalCents, split: split.type, shares: splitCents(totalCents, attendees, weights) };
}

// The whole trip. `items` are in board order (day, then time).
// Returns hundredths (paise / cents) everywhere plus whole-currency figures for display.
export function computeBudget({ items, participantIds, totalBudget, ceilings = new Map(), currency = DEFAULT_CURRENCY }) {
  const people = participantIds.map(String);
  const totals = new Map(people.map((id) => [id, 0]));
  const lines = [];
  for (const item of items) {
    const cost = itemCost(item, people);
    for (const [id, cents] of cost.shares) totals.set(id, (totals.get(id) ?? 0) + cents);
    lines.push({
      itemId: String(item.itemId ?? item._id),
      name: item.venue?.name,
      dayIndex: item.dayIndex,
      startTime: item.startTime,
      split: cost.split,
      attendees: cost.attendees,
      totalCents: cost.totalCents,
      shares: Object.fromEntries(cost.shares),
      // Running per-person totals after this item.
      runningCents: Object.fromEntries(totals),
    });
  }
  const groupCents = [...totals.values()].reduce((a, b) => a + b, 0);
  const budgetCents = toCents(totalBudget);
  return {
    currency,
    groupCents,
    budgetCents,
    remainingCents: budgetCents - groupCents,
    perPersonCents: Object.fromEntries(totals),
    lines,
    // Whole-currency view for clients.
    totalBudget: fromCents(budgetCents),
    groupCommitted: fromCents(groupCents),
    remaining: fromCents(budgetCents - groupCents),
    overBudget: groupCents > budgetCents,
    perPerson: people.map((id) => {
      const ceiling = ceilings.get(id) ?? null;
      const cents = totals.get(id);
      return {
        userId: id,
        committed: fromCents(cents),
        ceiling,
        remaining: ceiling == null ? null : fromCents(toCents(ceiling) - cents),
        overCeiling: ceiling != null && cents > toCents(ceiling),
      };
    }),
  };
}

// Compact figures for the live panel (trip.budget.update).
export function budgetPanel(budget, participantCount, itemCount) {
  const per = budget.perPerson.map((p) => p.committed);
  return {
    currency: budget.currency,
    totalBudget: budget.totalBudget,
    participantCount,
    itemCount,
    groupCommitted: budget.groupCommitted,
    remaining: budget.remaining,
    overBudget: budget.overBudget,
    // Kept for older clients: the largest per-person total.
    perPersonCommitted: per.length ? Math.max(...per) : 0,
    perPerson: budget.perPerson,
  };
}
