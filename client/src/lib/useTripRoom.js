import { useCallback, useEffect, useReducer, useRef } from 'react';
import { io } from 'socket.io-client';
import { getToken, onTokenChange, refresh } from './api.js';

// The live Trip Room. Holds the board, budget, people, chat, votes and
// conflicts, and keeps them in sync with the server's events. The server is
// the source of truth: the board only changes when a broadcast arrives.

const initial = {
  status: 'connecting', // connecting | live | reconnecting | removed | error
  error: null,
  trip: null,
  me: null,
  items: {},
  budget: null,
  participants: [],
  leader: null,
  conflicts: [],
  votes: {},
  chat: [],
  typing: {},
  rejection: null,
};

function reducer(state, { type, payload: p }) {
  switch (type) {
    case 'status':
      return { ...state, status: p.status, error: p.error ?? null };
    case 'trip.sync.state':
      return {
        ...state,
        status: 'live',
        error: null,
        trip: p.trip,
        me: p.me,
        items: Object.fromEntries(p.items.map((i) => [i.itemId, i])),
        budget: p.budget,
        participants: p.participants,
        leader: p.leader,
        conflicts: p.conflicts ?? [],
        votes: Object.fromEntries((p.votes ?? []).map((v) => [v.voteId, v])),
        chat: p.chat,
      };
    case 'trip.board.update': {
      const items = { ...state.items };
      if (p.action === 'removed') delete items[p.itemId];
      else items[p.itemId] = p.item;
      return { ...state, items };
    }
    case 'trip.board.rejected':
      return { ...state, rejection: { ...p, at: Date.now() } };
    case 'clearRejection':
      return { ...state, rejection: null };
    case 'trip.budget.update':
      return { ...state, budget: p };
    case 'trip.participants.update': {
      // A role change made over REST: update "me" too, so the UI follows at once.
      const mine = state.me && p.participants.find((x) => x.userId === state.me.userId);
      const me = mine && state.me.role !== 'admin' ? { ...state.me, role: mine.role, muted: mine.muted } : state.me;
      return { ...state, me, participants: p.participants, budget: p.budget ?? state.budget };
    }
    case 'trip.presence.update':
      return {
        ...state,
        participants: state.participants.map((x) =>
          x.userId === p.participantId ? { ...x, online: p.action === 'joined', connections: p.action === 'joined' ? 1 : 0 } : x,
        ),
      };
    case 'trip.presence.quality':
      return {
        ...state,
        participants: state.participants.map((x) => (x.userId === p.participantId ? { ...x, rttMs: p.rttMs, quality: p.quality } : x)),
      };
    case 'trip.participant.updated': {
      if (p.removed) return { ...state, participants: state.participants.filter((x) => x.userId !== p.userId) };
      const participants = state.participants.map((x) =>
        x.userId === p.userId ? { ...x, ...(p.muted !== undefined ? { muted: p.muted } : {}), ...(p.role ? { role: p.role } : {}) } : x,
      );
      const me = state.me && state.me.userId === p.userId
        ? { ...state.me, ...(p.muted !== undefined ? { muted: p.muted } : {}), ...(p.role ? { role: p.role } : {}) }
        : state.me;
      return { ...state, participants, me };
    }
    case 'trip.participant.removed':
      return { ...state, status: 'removed' };
    case 'trip.leader.status':
      return { ...state, leader: p };
    case 'trip.room.locked':
      return { ...state, trip: { ...state.trip, roomLocked: p.locked } };
    case 'trip.chat.message':
      if (state.chat.some((m) => m.messageId === p.messageId)) return state;
      return { ...state, chat: [...state.chat, p].slice(-200) };
    case 'trip.chat.reaction':
      return { ...state, chat: state.chat.map((m) => (m.messageId === p.messageId ? { ...m, reactions: p.reactions } : m)) };
    case 'trip.chat.typing': {
      const typing = { ...state.typing };
      if (p.isTyping) typing[p.userId] = { name: p.displayName, at: Date.now() };
      else delete typing[p.userId];
      return { ...state, typing };
    }
    case 'expireTyping': {
      const typing = Object.fromEntries(Object.entries(state.typing).filter(([, t]) => Date.now() - t.at < 6000));
      return Object.keys(typing).length === Object.keys(state.typing).length ? state : { ...state, typing };
    }
    case 'trip.board.conflict':
      return { ...state, conflicts: [...state.conflicts.filter((c) => c.conflictId !== p.conflictId), p] };
    case 'trip.board.conflictResolved':
      return { ...state, conflicts: state.conflicts.filter((c) => c.conflictId !== p.conflictId) };
    case 'trip.vote.open':
    case 'trip.split.open':
      return { ...state, votes: { ...state.votes, [p.voteId]: p } };
    case 'trip.vote.cast':
    case 'trip.split.cast': {
      const v = state.votes[p.voteId];
      if (!v) return state;
      return { ...state, votes: { ...state.votes, [p.voteId]: { ...v, tally: p.tally, ballotCount: p.ballotCount } } };
    }
    case 'trip.vote.resolved':
    case 'trip.split.resolved':
    case 'trip.vote.cancelled': {
      const votes = { ...state.votes };
      delete votes[p.voteId];
      return { ...state, votes };
    }
    default:
      return state;
  }
}

const EVENTS = [
  'trip.sync.state', 'trip.board.update', 'trip.board.rejected', 'trip.budget.update', 'trip.participants.update',
  'trip.presence.update', 'trip.presence.quality', 'trip.participant.updated', 'trip.participant.removed',
  'trip.leader.status', 'trip.room.locked', 'trip.chat.message', 'trip.chat.reaction', 'trip.chat.typing',
  'trip.board.conflict', 'trip.board.conflictResolved', 'trip.vote.open', 'trip.vote.cast', 'trip.vote.resolved',
  'trip.vote.cancelled', 'trip.split.open', 'trip.split.cast', 'trip.split.resolved',
];

export function useTripRoom(tripId) {
  const [state, dispatch] = useReducer(reducer, initial);
  const socketRef = useRef(null);
  const listeners = useRef(new Set());

  useEffect(() => {
    // `auth` as a function: every reconnect sends the current token.
    const socket = io('/trips', { auth: (cb) => cb({ token: getToken(), tripId }), transports: ['websocket'] });
    socketRef.current = socket;

    for (const ev of EVENTS) {
      socket.on(ev, (msg) => {
        dispatch({ type: ev, payload: msg.payload });
        for (const fn of listeners.current) fn(ev, msg.payload);
      });
    }
    socket.on('connect_error', async (err) => {
      const code = err.data?.code;
      if (code === 'TOKEN_EXPIRED') {
        await refresh().catch(() => {});
        socket.connect();
        return;
      }
      if (['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'INVALID_TOKEN'].includes(code)) {
        dispatch({ type: 'status', payload: { status: 'error', error: err.message } });
      } else {
        dispatch({ type: 'status', payload: { status: 'reconnecting' } });
      }
    });
    socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') dispatch({ type: 'status', payload: { status: 'reconnecting' } });
    });

    // A fresh access token goes to the open socket too.
    const off = onTokenChange((token) => {
      if (token && socket.connected) socket.emit('auth.renew', { payload: { token } }, () => {});
    });

    // Connection quality: ping every 10 s, report the round trip.
    const ping = setInterval(() => {
      if (!socket.connected) return;
      const sent = Date.now();
      socket.once('trip.sync.pong', () => {
        socket.emit('trip.sync.report', { payload: { rttMs: Date.now() - sent } }, () => {});
      });
      socket.emit('trip.sync.ping', { payload: { clientSentAt: sent } });
    }, 10000);
    const typingTimer = setInterval(() => dispatch({ type: 'expireTyping' }), 2000);

    return () => {
      off();
      clearInterval(ping);
      clearInterval(typingTimer);
      socket.close();
    };
  }, [tripId]);

  // Sends an event; resolves with the server's acknowledgement.
  const send = useCallback(
    (event, payload) =>
      new Promise((resolve) => {
        const socket = socketRef.current;
        if (!socket?.connected) return resolve({ ok: false, error: { code: 'OFFLINE', message: "You're offline; reconnecting" } });
        socket.timeout(15000).emit(event, { event, tripId, payload, ts: Date.now() }, (err, ack) => {
          resolve(err ? { ok: false, error: { code: 'TIMEOUT', message: 'The server did not answer in time' } } : ack);
        });
      }),
    [tripId],
  );

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  const clearRejection = useCallback(() => dispatch({ type: 'clearRejection' }), []);

  return { ...state, send, subscribe, clearRejection };
}
