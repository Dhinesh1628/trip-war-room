import { computeBudget, fromCents } from '../board/budgetEngine.js';

// Session analytics for one trip (spec 6.3), computed ONLY from the trip's
// event log. The final board is rebuilt by replaying the log, and the final
// budget is computed from that rebuilt board, so every number can be traced
// back to logged events. `reconcile` then compares the replay with what is
// actually stored.

const sortBySeq = (events) => {
  const seen = new Set();
  return [...events]
    .filter((e) => (seen.has(e.seq) ? false : seen.add(e.seq)))
    .sort((a, b) => a.seq - b.seq);
};

// Replays item events into the final board: Map itemId -> item.
export function replayBoard(events) {
  const board = new Map();
  for (const e of sortBySeq(events)) {
    const id = e.itemId ? String(e.itemId) : null;
    const d = e.data ?? {};
    switch (e.type) {
      case 'item_pinned':
        board.set(id, {
          itemId: id,
          venueId: d.venueId,
          venue: { name: d.name, pricePerPerson: d.pricePerPerson },
          dayIndex: d.dayIndex,
          startTime: d.startTime,
          endTime: d.endTime,
          lifecycleStage: 'drafting',
          attendeeIds: [],
          split: { type: 'even', weights: null },
        });
        break;
      case 'item_moved':
        if (board.has(id)) Object.assign(board.get(id), { dayIndex: d.dayIndex, startTime: d.startTime, endTime: d.endTime });
        break;
      case 'item_removed':
        board.delete(id);
        break;
      case 'item_locked':
        if (board.has(id)) board.get(id).lifecycleStage = 'locked';
        break;
      case 'item_unlocked':
        if (board.has(id)) board.get(id).lifecycleStage = 'drafting';
        break;
      case 'sharing_changed':
        if (board.has(id)) Object.assign(board.get(id), { attendeeIds: d.attendeeIds ?? [], split: d.split ?? { type: 'even' } });
        break;
      case 'vote_resolved':
        if (d.kind === 'slot') {
          for (const r of d.removedItemIds ?? []) board.delete(String(r));
          if (board.has(String(d.winnerItemId))) board.get(String(d.winnerItemId)).lifecycleStage = 'locked';
        }
        break;
      default:
        break;
    }
  }
  return board;
}

const boardOrder = (a, b) =>
  a.dayIndex - b.dayIndex || a.startTime.localeCompare(b.startTime) || String(a.itemId).localeCompare(String(b.itemId));

export function computeAnalytics(events, { participantIds, totalBudget, names = new Map() }) {
  const log = sortBySeq(events);
  const count = (type, pred = () => true) => log.filter((e) => e.type === type && pred(e)).length;
  const byKey = (type, key) =>
    log.filter((e) => e.type === type).reduce((m, e) => ((m[e.data?.[key]] = (m[e.data?.[key]] ?? 0) + 1), m), {});

  const first = log[0]?.ts ? new Date(log[0].ts) : null;
  const last = log.at(-1)?.ts ? new Date(log.at(-1).ts) : null;
  const presence = log.filter((e) => e.type === 'presence_joined' || e.type === 'presence_left');

  const board = replayBoard(log);
  const finalItems = [...board.values()].sort(boardOrder);
  const budget = computeBudget({ items: finalItems, participantIds, totalBudget });

  return {
    eventCount: log.length,
    planning: {
      firstEventAt: first?.toISOString() ?? null,
      lastEventAt: last?.toISOString() ?? null,
      // Time from the first to the last logged event.
      durationMinutes: first && last ? Math.round(((last - first) / 60000) * 10) / 10 : 0,
    },
    // The most travellers online at once, from the presence events.
    peakConcurrentPlanners: presence.reduce((m, e) => Math.max(m, e.data?.online ?? 0), 0),
    board: {
      pinned: count('item_pinned'),
      moved: count('item_moved'),
      removed: count('item_removed'),
      locked: count('item_locked'),
      finalItemCount: finalItems.length,
    },
    concierge: {
      questions: count('ai_asked'),
      byMode: byKey('ai_asked', 'mode'),
    },
    conflicts: {
      flagged: count('conflict_opened'),
      resolved: count('conflict_resolved'),
      stillOpen: count('conflict_opened') - count('conflict_resolved'),
      byType: byKey('conflict_opened', 'conflictType'),
    },
    votes: {
      opened: count('vote_opened'),
      resolved: count('vote_resolved'),
      cancelled: count('vote_cancelled'),
      ballots: count('vote_cast'),
      byKind: byKey('vote_opened', 'kind'),
    },
    chatMessages: count('chat_sent'),
    finalBudget: {
      currency: 'USD',
      totalBudget: budget.totalBudget,
      groupTotal: budget.groupCommitted,
      remaining: budget.remaining,
      perPerson: participantIds.map((id) => ({
        userId: String(id),
        displayName: names.get(String(id)) ?? null,
        total: fromCents(budget.perPersonCents[String(id)] ?? 0),
      })),
      items: budget.lines.map((l) => ({
        itemId: l.itemId,
        name: l.name,
        dayIndex: l.dayIndex,
        startTime: l.startTime,
        split: l.split,
        total: fromCents(l.totalCents),
        shares: Object.fromEntries(Object.entries(l.shares).map(([k, v]) => [k, fromCents(v)])),
      })),
    },
    _finalItems: finalItems,
  };
}

// Compares the board rebuilt from the log with the stored board.
export function reconcile(replayedItems, storedItems) {
  const key = (i) => ({
    dayIndex: i.dayIndex,
    startTime: i.startTime,
    endTime: i.endTime,
    venueId: i.venueId,
    lifecycleStage: i.lifecycleStage === 'voting' ? 'drafting' : i.lifecycleStage,
    attendeeIds: [...(i.attendeeIds ?? [])].map(String).sort(),
    split: i.split?.type ?? 'even',
  });
  const stored = new Map(storedItems.map((i) => [String(i._id ?? i.itemId), key(i)]));
  const replayed = new Map(replayedItems.map((i) => [String(i.itemId), key(i)]));
  const differences = [];
  for (const [id, k] of stored) {
    if (!replayed.has(id)) differences.push({ itemId: id, problem: 'stored but not in the log' });
    else if (JSON.stringify(replayed.get(id)) !== JSON.stringify(k)) {
      differences.push({ itemId: id, problem: 'differs', stored: k, replayed: replayed.get(id) });
    }
  }
  for (const id of replayed.keys()) if (!stored.has(id)) differences.push({ itemId: id, problem: 'in the log but not stored' });
  return { reconciled: differences.length === 0, differences };
}
