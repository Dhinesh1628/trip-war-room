// The board state machine (spec 6.1). Pure, synchronous logic over a Map of
// items: no database, no sockets. Because Node runs one handler at a time and
// nothing here awaits, "check the version, then apply" can never be split by
// another request, which is what makes concurrent moves deterministic.
//
// Item lifecycle:   drafting --lock--> locked --unlock (leader override)--> drafting
//                   drafting --openVote (Phase 3)--> voting --resolve--> drafting | locked
//
// Every function returns { ok: true, item } or { ok: false, code, message, current? }.

export const ERR = Object.freeze({
  NOT_FOUND: 'ITEM_NOT_FOUND',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  LOCKED: 'ITEM_LOCKED',
  IN_VOTE: 'ITEM_IN_VOTE',
  NOT_LOCKED: 'ITEM_NOT_LOCKED',
  BAD_SLOT: 'BAD_SLOT',
});

const fail = (code, message, current) => ({ ok: false, code, message, ...(current ? { current } : {}) });

function checkSlot({ dayIndex, startTime, endTime }, dayCount) {
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= dayCount) {
    return fail(ERR.BAD_SLOT, `dayIndex must be between 0 and ${dayCount - 1} for this trip`);
  }
  if (!(startTime < endTime)) return fail(ERR.BAD_SLOT, 'endTime must be after startTime');
  return null;
}

function editable(item) {
  if (item.lifecycleStage === 'locked') return fail(ERR.LOCKED, 'This item is locked by the trip leader', item);
  if (item.lifecycleStage === 'voting') return fail(ERR.IN_VOTE, 'This item is in a vote', item);
  return null;
}

const bump = (item, changes) => {
  Object.assign(item, changes, { positionVersion: item.positionVersion + 1, updatedAt: new Date() });
  return item;
};

export function pinItem(items, { id, tripId, venue, venueId, dayIndex, startTime, endTime, userId }, dayCount) {
  const bad = checkSlot({ dayIndex, startTime, endTime }, dayCount);
  if (bad) return bad;
  const now = new Date();
  const item = {
    _id: id,
    tripId,
    venueId,
    venue,
    dayIndex,
    startTime,
    endTime,
    lifecycleStage: 'drafting',
    pinnedByUserId: userId,
    positionVersion: 1,
    lockedByUserId: null,
    votes: {},
    createdAt: now,
    updatedAt: now,
  };
  items.set(String(id), item);
  return { ok: true, item };
}

// Optimistic concurrency: the move must quote the version the client last
// saw. If someone else changed the item since, the move is rejected and the
// caller gets the current item so its UI can snap back to the truth.
export function moveItem(items, { itemId, dayIndex, startTime, endTime, expectedVersion }, dayCount) {
  const item = items.get(String(itemId));
  if (!item) return fail(ERR.NOT_FOUND, 'Item not found');
  const blocked = editable(item);
  if (blocked) return blocked;
  if (item.positionVersion !== expectedVersion) {
    return fail(
      ERR.VERSION_CONFLICT,
      `Someone else changed this item first (you had version ${expectedVersion}, it is now ${item.positionVersion})`,
      item,
    );
  }
  const bad = checkSlot({ dayIndex, startTime, endTime }, dayCount);
  if (bad) return bad;
  return { ok: true, item: bump(item, { dayIndex, startTime, endTime }) };
}

export function removeItem(items, { itemId, expectedVersion }) {
  const item = items.get(String(itemId));
  if (!item) return fail(ERR.NOT_FOUND, 'Item not found');
  const blocked = editable(item);
  if (blocked) return blocked;
  if (item.positionVersion !== expectedVersion) {
    return fail(ERR.VERSION_CONFLICT, 'Someone else changed this item first', item);
  }
  items.delete(String(itemId));
  return { ok: true, item };
}

export function lockItem(items, { itemId, userId }) {
  const item = items.get(String(itemId));
  if (!item) return fail(ERR.NOT_FOUND, 'Item not found');
  if (item.lifecycleStage === 'locked') return fail(ERR.LOCKED, 'Item is already locked', item);
  if (item.lifecycleStage === 'voting') return fail(ERR.IN_VOTE, 'Resolve the vote before locking', item);
  return { ok: true, item: bump(item, { lifecycleStage: 'locked', lockedByUserId: userId }) };
}

// Leader override on a finalised item.
export function unlockItem(items, { itemId }) {
  const item = items.get(String(itemId));
  if (!item) return fail(ERR.NOT_FOUND, 'Item not found');
  if (item.lifecycleStage !== 'locked') return fail(ERR.NOT_LOCKED, 'Item is not locked', item);
  return { ok: true, item: bump(item, { lifecycleStage: 'drafting', lockedByUserId: null }) };
}

// What clients receive for an item. Matches the spec's trip.board.update
// fields, plus the venue snapshot the UI needs to draw the card.
export function publicItem(item) {
  return {
    itemId: String(item._id),
    venueId: item.venueId,
    venue: item.venue,
    dayIndex: item.dayIndex,
    startTime: item.startTime,
    endTime: item.endTime,
    lifecycleStage: item.lifecycleStage,
    positionVersion: item.positionVersion,
    pinnedByUserId: String(item.pinnedByUserId),
    lockedByUserId: item.lockedByUserId ? String(item.lockedByUserId) : null,
    updatedAt: item.updatedAt,
  };
}

// Stable board order: by day, then start time, then id.
export function sortedItems(items) {
  return [...items.values()].sort(
    (a, b) =>
      a.dayIndex - b.dayIndex ||
      a.startTime.localeCompare(b.startTime) ||
      String(a._id).localeCompare(String(b._id)),
  );
}
