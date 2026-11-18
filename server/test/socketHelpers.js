import { io as connect } from 'socket.io-client';

// A scripted traveller: connects to a Trip Room, records every event it
// receives, and offers small helpers to send events and wait for others.
export async function joinRoom(url, { token, tripId }, { timeoutMs = 4000 } = {}) {
  const socket = connect(`${url}/trips`, {
    auth: { token, tripId },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  const events = [];
  const waiters = [];

  socket.onAny((event, msg) => {
    const entry = { event, msg, at: Date.now() };
    events.push(entry);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(entry)) {
        waiters[i].resolve(entry.msg);
        waiters.splice(i, 1);
      }
    }
  });

  const connectedAt = Date.now();
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no snapshot received')), timeoutMs);
    socket.once('trip.sync.state', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return {
    socket,
    snapshot,
    snapshotMs: Date.now() - connectedAt,
    events,
    // Sends an event and resolves with the server's acknowledgement.
    send(event, payload) {
      return socket.timeout(timeoutMs).emitWithAck(event, { event, tripId, payload, ts: Date.now() });
    },
    // Resolves with the next matching event (or one already received after `since`).
    waitFor(event, predicate = () => true, { since = 0, timeout = timeoutMs } = {}) {
      const match = (e) => e.event === event && e.at >= since && predicate(e.msg);
      const seen = events.find(match);
      if (seen) return Promise.resolve(seen.msg);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`timed out waiting for ${event}`));
          }
        }, timeout);
      });
    },
    count(event, predicate = () => true) {
      return events.filter((e) => e.event === event && predicate(e.msg)).length;
    },
    close() {
      socket.close();
    },
  };
}

// Expects the handshake to be refused; resolves with the error data.
export function expectRefused(url, auth) {
  return new Promise((resolve, reject) => {
    const socket = connect(`${url}/trips`, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect_error', (err) => {
      socket.close();
      resolve(err.data || {});
    });
    socket.once('trip.sync.state', () => {
      socket.close();
      reject(new Error('connection was accepted'));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
