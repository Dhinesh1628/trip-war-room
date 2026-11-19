// A read-only copy of each trip's board, kept in this browser so the trip
// can still be viewed without a connection. Saved whenever the live board
// changes; never sent anywhere. If storage is unavailable, nothing breaks.
const key = (tripId) => `twr.board.${tripId}`;
const MAX_TRIPS = 10;

export function saveBoard(tripId, room) {
  try {
    const snap = {
      savedAt: new Date().toISOString(),
      trip: room.trip,
      items: room.items,
      participants: room.participants.map((p) => ({ userId: p.userId, displayName: p.displayName, role: p.role, online: false })),
      budget: room.budget,
      me: room.me,
    };
    localStorage.setItem(key(tripId), JSON.stringify(snap));
    const index = JSON.parse(localStorage.getItem('twr.boards') ?? '[]').filter((id) => id !== tripId);
    index.unshift(tripId);
    for (const old of index.slice(MAX_TRIPS)) localStorage.removeItem(key(old));
    localStorage.setItem('twr.boards', JSON.stringify(index.slice(0, MAX_TRIPS)));
  } catch {
    // storage full or blocked: the live board still works
  }
}

export function loadBoard(tripId) {
  try {
    const raw = localStorage.getItem(key(tripId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Sign-out clears saved boards, so the next person on this device can't see them.
export function clearBoards() {
  try {
    for (const id of JSON.parse(localStorage.getItem('twr.boards') ?? '[]')) localStorage.removeItem(key(id));
    localStorage.removeItem('twr.boards');
  } catch {
    // nothing to clear
  }
}
