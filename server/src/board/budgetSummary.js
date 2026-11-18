// Running budget totals for the live budget panel. All arithmetic is in
// integer cents so totals are exact (no 0.1 + 0.2 problems).
// Phase 2 assumes every participant attends every pinned item (an even split).
// Phase 4 replaces this with the full engine: weighted splits, per-person
// attendance and per-traveller ceilings.

export const toCents = (dollars) => Math.round(Number(dollars) * 100);
export const fromCents = (cents) => cents / 100;

export function budgetSummary({ totalBudget, participantCount, items }) {
  const perPersonCents = items.reduce((sum, item) => sum + toCents(item.venue?.pricePerPerson ?? 0), 0);
  const groupCents = perPersonCents * participantCount;
  const totalCents = toCents(totalBudget);
  return {
    currency: 'USD',
    totalBudget: fromCents(totalCents),
    participantCount,
    perPersonCommitted: fromCents(perPersonCents),
    groupCommitted: fromCents(groupCents),
    remaining: fromCents(totalCents - groupCents),
    overBudget: groupCents > totalCents,
    itemCount: items.length,
  };
}
