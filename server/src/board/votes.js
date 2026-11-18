import { toMinutes } from '../concierge/constraints.js';

// Contested-slot voting (spec 6.2), as pure functions over the room's items
// and votes. Lifecycle of the items involved:
//   drafting --open--> voting --resolve--> winner: locked, others: removed
//                              --cancel--> all back to drafting
// Every function returns { ok: true, ... } or { ok: false, code, message }.

const fail = (code, message) => ({ ok: false, code, message });
const id = (x) => String(x._id ?? x.itemId);

// Items share a contested slot when they are on the same day and all overlap
// one common stretch of time.
export function shareASlot(list) {
  if (list.length < 2) return false;
  if (new Set(list.map((i) => i.dayIndex)).size !== 1) return false;
  const latestStart = Math.max(...list.map((i) => toMinutes(i.startTime)));
  const earliestEnd = Math.min(...list.map((i) => toMinutes(i.endTime)));
  return latestStart < earliestEnd;
}

export function openVote(items, { voteId, itemIds, openedByUserId, closesAt }) {
  const unique = [...new Set(itemIds.map(String))];
  if (unique.length < 2) return fail('VOTE_NEEDS_TWO', 'A vote needs at least two items');
  if (unique.length > 6) return fail('VOTE_TOO_MANY', 'A vote can have at most six options');
  const list = unique.map((i) => items.get(i));
  if (list.some((i) => !i)) return fail('ITEM_NOT_FOUND', 'Item not found');
  const busy = list.find((i) => i.lifecycleStage !== 'drafting');
  if (busy) {
    return fail(
      busy.lifecycleStage === 'locked' ? 'ITEM_LOCKED' : 'ITEM_IN_VOTE',
      `${busy.venue.name} is ${busy.lifecycleStage === 'locked' ? 'locked' : 'already in a vote'}`,
    );
  }
  if (!shareASlot(list)) return fail('NOT_CONTESTED', 'These items are not competing for the same time slot');

  const now = new Date();
  for (const item of list) {
    item.lifecycleStage = 'voting';
    item.positionVersion += 1;
    item.updatedAt = now;
  }
  const vote = {
    _id: voteId,
    itemIds: unique,
    candidates: list.map((i) => ({ itemId: id(i), venueId: i.venueId, name: i.venue.name })),
    openedByUserId: openedByUserId ?? null,
    closesAt,
    ballots: new Map(),
    status: 'open',
    createdAt: now,
  };
  return { ok: true, vote, items: list };
}

// One ballot per traveller; casting again changes it.
export function castBallot(vote, { userId, itemId }) {
  if (vote.status !== 'open') return fail('VOTE_CLOSED', 'This vote has already closed');
  if (!vote.itemIds.includes(String(itemId))) return fail('NOT_A_CANDIDATE', 'That item is not an option in this vote');
  const changed = vote.ballots.has(userId);
  vote.ballots.set(userId, String(itemId));
  return { ok: true, changed };
}

export function tallyOf(vote) {
  const tally = Object.fromEntries(vote.itemIds.map((i) => [i, 0]));
  for (const choice of vote.ballots.values()) if (choice in tally) tally[choice] += 1;
  return tally;
}

// Decides the winner deterministically: most votes; a tie (or no votes at
// all) goes to the option that was pinned first, then the lower id. Applies
// it: the winner is locked in place, the other options leave the board.
export function resolveVote(items, vote) {
  if (vote.status !== 'open') return fail('VOTE_CLOSED', 'This vote has already closed');
  const tally = tallyOf(vote);
  const options = vote.itemIds.map((i) => items.get(i)).filter(Boolean);
  if (!options.length) return fail('ITEM_NOT_FOUND', 'The items in this vote are gone');

  const best = Math.max(...options.map((o) => tally[id(o)] ?? 0));
  const leaders = options.filter((o) => (tally[id(o)] ?? 0) === best);
  leaders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || id(a).localeCompare(id(b)));
  const winner = leaders[0];
  const resolution = best === 0 ? 'no_votes_earliest_pin' : leaders.length > 1 ? 'tie_earliest_pin' : 'votes';

  const now = new Date();
  winner.lifecycleStage = 'locked';
  winner.lockedByUserId = null; // locked by the vote, not a person
  winner.positionVersion += 1;
  winner.updatedAt = now;
  const removed = options.filter((o) => o !== winner);
  for (const r of removed) items.delete(id(r));

  Object.assign(vote, {
    status: 'resolved',
    winnerItemId: id(winner),
    winningVenueId: winner.venueId,
    tally,
    resolvedAt: now,
    resolution,
  });
  return { ok: true, winner, removed, tally, resolution };
}

export function cancelVote(items, vote) {
  if (vote.status !== 'open') return fail('VOTE_CLOSED', 'This vote has already closed');
  const now = new Date();
  const restored = [];
  for (const itemId of vote.itemIds) {
    const item = items.get(itemId);
    if (item?.lifecycleStage === 'voting') {
      item.lifecycleStage = 'drafting';
      item.positionVersion += 1;
      item.updatedAt = now;
      restored.push(item);
    }
  }
  Object.assign(vote, { status: 'cancelled', resolvedAt: now, tally: tallyOf(vote) });
  return { ok: true, restored };
}

// ---- budget-split votes ------------------------------------------------------
// "Should we change who pays what for this item?" Ballots are 'yes' / 'no'.
// The change applies if more people vote yes than no; a tie keeps things as
// they are. If the item changed in the meantime, the proposal is dropped.

export function openSplitVote(items, { voteId, itemId, proposal, openedByUserId, closesAt }) {
  const item = items.get(String(itemId));
  if (!item) return fail('ITEM_NOT_FOUND', 'Item not found');
  if (item.lifecycleStage !== 'drafting') return fail('ITEM_LOCKED', `${item.venue.name} can't be changed right now`);
  const vote = {
    _id: voteId,
    kind: 'split',
    itemIds: [String(itemId)],
    candidates: [{ itemId: String(itemId), venueId: item.venueId, name: item.venue.name }],
    proposal,
    expectedVersion: item.positionVersion,
    openedByUserId: openedByUserId ?? null,
    closesAt,
    ballots: new Map(),
    status: 'open',
    createdAt: new Date(),
  };
  return { ok: true, vote, item };
}

export function castSplitBallot(vote, { userId, choice }) {
  if (vote.status !== 'open') return fail('VOTE_CLOSED', 'This vote has already closed');
  if (choice !== 'yes' && choice !== 'no') return fail('NOT_A_CANDIDATE', 'Vote yes or no');
  const changed = vote.ballots.has(userId);
  vote.ballots.set(userId, choice);
  return { ok: true, changed };
}

export function splitTally(vote) {
  const t = { yes: 0, no: 0 };
  for (const c of vote.ballots.values()) if (c in t) t[c] += 1;
  return t;
}

// Decides a split vote. Returns { ok, apply, reason, tally }; the caller
// applies the proposal (through setSharing) when apply is true.
export function decideSplitVote(items, vote) {
  if (vote.status !== 'open') return fail('VOTE_CLOSED', 'This vote has already closed');
  const tally = splitTally(vote);
  const item = items.get(vote.itemIds[0]);
  let apply = tally.yes > tally.no;
  let reason = apply ? 'majority_yes' : tally.yes === tally.no ? 'tie_keeps_current' : 'majority_no';
  if (apply && (!item || item.positionVersion !== vote.expectedVersion)) {
    apply = false;
    reason = 'item_changed';
  }
  Object.assign(vote, { status: 'resolved', tally, resolvedAt: new Date(), resolution: reason });
  return { ok: true, apply, reason, tally, item };
}

// Public shape for clients.
export function publicVote(vote) {
  if (vote.kind === 'split') {
    return {
      voteId: String(vote._id),
      kind: 'split',
      itemId: vote.itemIds[0],
      name: vote.candidates?.[0]?.name,
      proposal: vote.proposal,
      openedByUserId: vote.openedByUserId ? String(vote.openedByUserId) : null,
      closesAt: new Date(vote.closesAt).toISOString(),
      status: vote.status,
      ballotCount: vote.ballots.size,
      tally: splitTally(vote),
      ...(vote.status !== 'open' ? { resolution: vote.resolution ?? null } : {}),
    };
  }
  return {
    voteId: String(vote._id),
    kind: 'slot',
    itemIds: vote.itemIds,
    candidates: vote.candidates,
    candidateVenueIds: vote.candidates.map((c) => c.venueId),
    openedByUserId: vote.openedByUserId ? String(vote.openedByUserId) : null,
    closesAt: new Date(vote.closesAt).toISOString(),
    status: vote.status,
    ballotCount: vote.ballots.size,
    tally: tallyOf(vote),
    ...(vote.status !== 'open'
      ? { winnerItemId: vote.winnerItemId ?? null, winningVenueId: vote.winningVenueId ?? null, resolution: vote.resolution ?? null }
      : {}),
  };
}
