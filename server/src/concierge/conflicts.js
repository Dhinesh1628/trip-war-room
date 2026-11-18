import { distanceKm } from '../venues/geo.js';
import { toMinutes, isOpenFor, walkMinutes } from './constraints.js';
import { computeBudget, toCents, fromCents } from '../board/budgetEngine.js';

// The conflict detector (spec 5.3 / 6.2). Pure: given the board and the
// travellers, it lists every current problem. The gateway runs it after each
// board change and announces conflicts that appeared or went away.
//
// Types:
//  - overlap      two items on the same day overlap in time ("time"), or the
//                 gap between them is shorter than the trip between them ("travel")
//  - budgetBreach the board pushes a traveller past their declared ceiling,
//                 or the group past the trip budget
//  - hours        an item is scheduled while its venue is closed
// Each conflict has a stable `conflictId`, so the same problem is not
// announced twice.

// Minutes needed to get from a to b: walking up to 2.5 km, otherwise public
// transport at ~20 km/h plus 10 minutes of waiting.
export function travelMinutes(a, b) {
  const km = distanceKm(a, b);
  return km <= 2.5 ? walkMinutes(km) : Math.round(10 + (km / 20) * 60);
}

const slotOf = (item) => ({ start: toMinutes(item.startTime), end: toMinutes(item.endTime) });
const idOf = (item) => String(item.itemId ?? item._id);

export function detectConflicts({ items, participantIds, travellers, names = new Map(), totalBudget }) {
  const conflicts = [];

  // ---- time overlaps and impossible travel, day by day
  const byDay = new Map();
  for (const item of items) {
    if (!byDay.has(item.dayIndex)) byDay.set(item.dayIndex, []);
    byDay.get(item.dayIndex).push(item);
  }
  for (const [dayIndex, dayItems] of byDay) {
    const sorted = [...dayItems].sort((a, b) => a.startTime.localeCompare(b.startTime) || idOf(a).localeCompare(idOf(b)));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        const sa = slotOf(a);
        const sb = slotOf(b);
        if (sa.start < sb.end && sb.start < sa.end) {
          const ids = [idOf(a), idOf(b)].sort();
          conflicts.push({
            conflictId: `overlap:time:${ids.join(':')}`,
            conflictType: 'overlap',
            itemIds: ids,
            details: {
              reason: 'time',
              dayIndex,
              message: `${a.venue.name} (${a.startTime}-${a.endTime}) and ${b.venue.name} (${b.startTime}-${b.endTime}) overlap on day ${dayIndex + 1}`,
            },
          });
        }
      }
    }
    // Consecutive, non-overlapping items: is there time to get there?
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gap = slotOf(b).start - slotOf(a).end;
      if (gap < 0) continue; // already an overlap
      const need = travelMinutes(a.venue.coordinates, b.venue.coordinates);
      if (gap < need) {
        const ids = [idOf(a), idOf(b)];
        conflicts.push({
          conflictId: `overlap:travel:${ids.join(':')}`,
          conflictType: 'overlap',
          itemIds: ids,
          details: {
            reason: 'travel',
            dayIndex,
            gapMinutes: gap,
            travelMinutes: need,
            message: `Only ${gap} min between ${a.venue.name} and ${b.venue.name} on day ${dayIndex + 1}, but the trip takes about ${need} min`,
          },
        });
      }
    }
  }

  // ---- venue closed during the item
  for (const item of items) {
    if (!item.venue.hours || item.venue.category === 'lodging') continue;
    if (!isOpenFor(item.venue.hours, slotOf(item))) {
      conflicts.push({
        conflictId: `hours:${idOf(item)}`,
        conflictType: 'hours',
        itemIds: [idOf(item)],
        details: {
          message: `${item.venue.name} is open ${item.venue.hours.open}-${item.venue.hours.close}, but is scheduled ${item.startTime}-${item.endTime}`,
        },
      });
    }
  }

  // ---- budget: per-person shares from the budget engine (attendance and
  // weighted splits included), added up in the order items were pinned, so
  // the item that "pushed" someone over is the one pinned when it happened.
  const inPinOrder = [...items].sort(
    (a, b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0) || idOf(a).localeCompare(idOf(b)),
  );
  const budget = computeBudget({ items: inPinOrder, participantIds, totalBudget });
  for (const userId of participantIds.map(String)) {
    const ceiling = travellers.get(userId)?.budgetCeiling;
    const cents = budget.perPersonCents[userId] ?? 0;
    if (ceiling == null || cents <= toCents(ceiling)) continue;
    const crossing = budget.lines.find((l) => l.runningCents[userId] > toCents(ceiling));
    conflicts.push({
      conflictId: `budget:traveller:${userId}`,
      conflictType: 'budgetBreach',
      itemIds: [crossing.itemId],
      details: {
        scope: 'traveller',
        userId,
        ceiling,
        committed: fromCents(cents),
        over: fromCents(cents - toCents(ceiling)),
        message: `${names.get(userId) ?? 'A traveller'} is $${fromCents(cents - toCents(ceiling))} over their $${ceiling} budget (now $${fromCents(cents)})`,
      },
    });
  }
  if (budget.groupCents > budget.budgetCents) {
    let running = 0;
    const crossing = budget.lines.find((l) => (running += l.totalCents) > budget.budgetCents);
    conflicts.push({
      conflictId: 'budget:group',
      conflictType: 'budgetBreach',
      itemIds: [crossing.itemId],
      details: {
        scope: 'group',
        ceiling: totalBudget,
        committed: fromCents(budget.groupCents),
        over: fromCents(budget.groupCents - budget.budgetCents),
        message: `The group is $${fromCents(budget.groupCents - budget.budgetCents)} over the $${totalBudget} trip budget`,
      },
    });
  }

  return conflicts.sort((a, b) => a.conflictId.localeCompare(b.conflictId));
}

// What changed between two runs: { opened: [...], resolved: [...] }.
export function diffConflicts(previous, current) {
  const before = new Map(previous.map((c) => [c.conflictId, c]));
  const after = new Map(current.map((c) => [c.conflictId, c]));
  return {
    opened: current.filter((c) => !before.has(c.conflictId)),
    resolved: previous.filter((c) => !after.has(c.conflictId)),
  };
}
