import { pinItem, moveItem, removeItem, lockItem, unlockItem, sortedItems, ERR } from '../src/board/boardState.js';
import { sanitizeChat } from '../src/chat/sanitize.js';

// The board state machine on its own: no database, no sockets (spec 10 / 12.1).

const DAYS = 5;
let items;
let seq;

const pin = (over = {}) =>
  pinItem(
    items,
    {
      id: `i${(seq += 1)}`,
      tripId: 't1',
      venueId: 'v_lis_001',
      venue: { name: 'Taberna', pricePerPerson: 22 },
      dayIndex: 0,
      startTime: '19:00',
      endTime: '21:00',
      userId: 'u1',
      ...over,
    },
    DAYS,
  );

beforeEach(() => {
  items = new Map();
  seq = 0;
});

describe('pin', () => {
  test('a new item starts in drafting at version 1', () => {
    const r = pin();
    expect(r.ok).toBe(true);
    expect(r.item).toMatchObject({ lifecycleStage: 'drafting', positionVersion: 1, dayIndex: 0 });
    expect(items.size).toBe(1);
  });

  test.each([
    [{ dayIndex: 5 }, 'day past the end of the trip'],
    [{ dayIndex: -1 }, 'negative day'],
    [{ startTime: '21:00', endTime: '19:00' }, 'end before start'],
    [{ startTime: '19:00', endTime: '19:00' }, 'zero length'],
  ])('rejects %j (%s)', (over) => {
    const r = pin(over);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(ERR.BAD_SLOT);
    expect(items.size).toBe(0);
  });
});

describe('move with optimistic concurrency', () => {
  test('a move quoting the current version succeeds and bumps the version', () => {
    const { item } = pin();
    const r = moveItem(items, { itemId: item._id, dayIndex: 2, startTime: '12:00', endTime: '13:00', expectedVersion: 1 }, DAYS);
    expect(r.ok).toBe(true);
    expect(r.item).toMatchObject({ dayIndex: 2, startTime: '12:00', positionVersion: 2 });
  });

  test('two moves quoting the same version: the first wins, the second gets the current item', () => {
    const { item } = pin();
    const a = moveItem(items, { itemId: item._id, dayIndex: 1, startTime: '10:00', endTime: '11:00', expectedVersion: 1 }, DAYS);
    const b = moveItem(items, { itemId: item._id, dayIndex: 3, startTime: '15:00', endTime: '16:00', expectedVersion: 1 }, DAYS);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.code).toBe(ERR.VERSION_CONFLICT);
    expect(b.current).toMatchObject({ dayIndex: 1, startTime: '10:00', positionVersion: 2 });
    // The loser's change was not applied.
    expect(items.get(item._id)).toMatchObject({ dayIndex: 1, positionVersion: 2 });
  });

  test('after reconciling (using the new version) the second planner can move it', () => {
    const { item } = pin();
    moveItem(items, { itemId: item._id, dayIndex: 1, startTime: '10:00', endTime: '11:00', expectedVersion: 1 }, DAYS);
    const retry = moveItem(items, { itemId: item._id, dayIndex: 3, startTime: '15:00', endTime: '16:00', expectedVersion: 2 }, DAYS);
    expect(retry.ok).toBe(true);
    expect(retry.item.positionVersion).toBe(3);
  });

  test('a stale move never changes anything, whatever order 50 stale moves arrive in', () => {
    const { item } = pin();
    moveItem(items, { itemId: item._id, dayIndex: 4, startTime: '08:00', endTime: '09:00', expectedVersion: 1 }, DAYS);
    for (let i = 0; i < 50; i += 1) {
      const r = moveItem(items, { itemId: item._id, dayIndex: i % DAYS, startTime: '10:00', endTime: '11:00', expectedVersion: 1 }, DAYS);
      expect(r.code).toBe(ERR.VERSION_CONFLICT);
    }
    expect(items.get(item._id)).toMatchObject({ dayIndex: 4, startTime: '08:00', positionVersion: 2 });
  });

  test('moving an unknown item or to a bad slot fails cleanly', () => {
    const { item } = pin();
    expect(moveItem(items, { itemId: 'nope', dayIndex: 0, startTime: '10:00', endTime: '11:00', expectedVersion: 1 }, DAYS).code).toBe(ERR.NOT_FOUND);
    const bad = moveItem(items, { itemId: item._id, dayIndex: 9, startTime: '10:00', endTime: '11:00', expectedVersion: 1 }, DAYS);
    expect(bad.code).toBe(ERR.BAD_SLOT);
    expect(items.get(item._id).positionVersion).toBe(1);
  });
});

describe('lifecycle: drafting -> locked -> (leader override) -> drafting', () => {
  test('locked items cannot be moved or removed', () => {
    const { item } = pin();
    const locked = lockItem(items, { itemId: item._id, userId: 'leader' });
    expect(locked.item).toMatchObject({ lifecycleStage: 'locked', positionVersion: 2, lockedByUserId: 'leader' });
    expect(moveItem(items, { itemId: item._id, dayIndex: 1, startTime: '10:00', endTime: '11:00', expectedVersion: 2 }, DAYS).code).toBe(ERR.LOCKED);
    expect(removeItem(items, { itemId: item._id, expectedVersion: 2 }).code).toBe(ERR.LOCKED);
    expect(lockItem(items, { itemId: item._id, userId: 'leader' }).code).toBe(ERR.LOCKED);
  });

  test('unlock returns the item to drafting so it can move again', () => {
    const { item } = pin();
    lockItem(items, { itemId: item._id, userId: 'leader' });
    const unlocked = unlockItem(items, { itemId: item._id });
    expect(unlocked.item).toMatchObject({ lifecycleStage: 'drafting', positionVersion: 3, lockedByUserId: null });
    expect(moveItem(items, { itemId: item._id, dayIndex: 1, startTime: '10:00', endTime: '11:00', expectedVersion: 3 }, DAYS).ok).toBe(true);
  });

  test('unlocking an item that is not locked fails', () => {
    const { item } = pin();
    expect(unlockItem(items, { itemId: item._id }).code).toBe(ERR.NOT_LOCKED);
  });

  test('items in a vote cannot be moved, removed or locked', () => {
    const { item } = pin();
    item.lifecycleStage = 'voting';
    expect(moveItem(items, { itemId: item._id, dayIndex: 1, startTime: '10:00', endTime: '11:00', expectedVersion: 1 }, DAYS).code).toBe(ERR.IN_VOTE);
    expect(removeItem(items, { itemId: item._id, expectedVersion: 1 }).code).toBe(ERR.IN_VOTE);
    expect(lockItem(items, { itemId: item._id, userId: 'l' }).code).toBe(ERR.IN_VOTE);
  });

  test('remove needs the current version too', () => {
    const { item } = pin();
    moveItem(items, { itemId: item._id, dayIndex: 1, startTime: '10:00', endTime: '11:00', expectedVersion: 1 }, DAYS);
    expect(removeItem(items, { itemId: item._id, expectedVersion: 1 }).code).toBe(ERR.VERSION_CONFLICT);
    expect(removeItem(items, { itemId: item._id, expectedVersion: 2 }).ok).toBe(true);
    expect(items.size).toBe(0);
  });
});

test('board order is day, then start time, then id', () => {
  pin({ dayIndex: 1, startTime: '09:00', endTime: '10:00' });
  pin({ dayIndex: 0, startTime: '18:00', endTime: '19:00' });
  pin({ dayIndex: 0, startTime: '08:00', endTime: '09:00' });
  expect(sortedItems(items).map((i) => `${i.dayIndex}@${i.startTime}`)).toEqual(['0@08:00', '0@18:00', '1@09:00']);
});

describe('chat sanitising (stored XSS defence)', () => {
  test.each([
    ['<script>alert(1)</script>hello', 'alert(1)hello'],
    ['<img src=x onerror=alert(1)>hi', 'hi'],
    ['<b>bold</b> text', 'bold text'],
    ['I <3 Lisbon', 'I <3 Lisbon'],
    ['5 < 6 and 7 > 3', '5 < 6 and 7 > 3'],
    ['  spaced  \n\n\n\nout  ', 'spaced  \n\nout'],
    ['zero​width\u0000null', 'zerowidthnull'],
    [42, ''],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeChat(input)).toBe(expected);
  });
});
