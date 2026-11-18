import mongoose from 'mongoose';
import { authenticate } from '../auth/middleware.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { Trip } from '../trips/trip.model.js';
import { envelope } from './envelope.js';
import { makeHandler, BoardError } from './handler.js';
import { schemas } from '../board/schemas.js';
import { pinItem, moveItem, removeItem, lockItem, unlockItem, publicItem, ERR } from '../board/boardState.js';
import { sanitizeChat, MAX_CHAT_LENGTH } from '../chat/sanitize.js';
import { saveMessage, history, messageView, toggleReaction } from '../chat/chatService.js';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { bus, TRIP_CHANGED, USER_CHANGED } from '../lib/bus.js';
import { publicVote } from '../board/votes.js';
import { log } from '../lib/logger.js';

export const NAMESPACE = '/trips';

const qualityOf = (rttMs) => (rttMs < 150 ? 'good' : rttMs < 400 ? 'fair' : 'poor');

// The Trip Room namespace. One socket connection = one traveller in one room:
//   io('/trips', { auth: { token, tripId } })
export function attachTripNamespace(io, { config, registry, actions, ask, emit }) {
  const nsp = io.of(NAMESPACE);
  const emitRoom = emit;

  // ---- handshake: same JWT and same membership rule as the REST API --------
  nsp.use(async (socket, next) => {
    try {
      const { token, tripId } = socket.handshake.auth || {};
      // The token check is local; the three database reads below are
      // independent, so they run in parallel (one round trip, not three).
      verifyAccessToken(token, config);
      if (!mongoose.isValidObjectId(tripId)) throw notFound('Trip not found');
      const [user, , chat] = await Promise.all([
        authenticate(token, config),
        registry.open(String(tripId)),
        history(String(tripId), { limit: config.chatHistoryLimit }),
      ]);
      const room = registry.get(String(tripId));
      if (!room) throw notFound('Trip not found');
      // Same membership rule as REST (roles.js), checked against the room's
      // copy of the trip, which REST changes keep up to date.
      const role = room.roleOf(user);
      if (!role) {
        registry.close(room.tripId); // only closes if nobody is in it
        throw forbidden('You are not a participant in this trip');
      }
      room.pendingJoins += 1; // keeps the room open until the connection is set up
      socket.data = { user, tripId: room.tripId, chat, pending: true };
      next();
    } catch (err) {
      const e = new Error(err instanceof HttpError ? err.message : 'Connection refused');
      e.data = { code: err instanceof HttpError ? err.code : 'INTERNAL', status: err.status || 500 };
      next(e);
    }
  });

  nsp.on('connection', (socket) => {
    const { user, tripId } = socket.data;
    const room = registry.get(tripId);
    if (!room) {
      socket.emit('trip.error', envelope('trip.error', tripId, { code: 'ROOM_CLOSED' }));
      socket.disconnect(true);
      return;
    }
    socket.join(tripId);
    room.pendingJoins -= 1;
    socket.data.pending = false;

    // ---- presence (a quick reconnect inside the grace window is invisible) ----
    const leaderWasConnected = room.leaderConnected;
    let entry = room.presence.get(user.id);
    const newPresence = !entry;
    if (entry?.leaveTimer) {
      clearTimeout(entry.leaveTimer);
      entry.leaveTimer = null;
    }
    if (!entry) {
      entry = { sockets: new Set(), rttMs: null, quality: null, leaveTimer: null };
      room.presence.set(user.id, entry);
    }
    entry.sockets.add(socket.id);

    // ---- full snapshot, built synchronously so no broadcast can slip in between
    socket.emit(
      'trip.sync.state',
      envelope('trip.sync.state', tripId, {
        trip: {
          tripId,
          destination: room.trip.destinationName,
          destinationSlug: room.trip.destination,
          startDate: room.trip.startDate,
          endDate: room.trip.endDate,
          dayCount: room.trip.dayCount,
          totalBudget: room.trip.totalBudget,
          roomLocked: room.trip.roomLocked,
          status: room.trip.status,
        },
        me: { userId: user.id, role: room.roleOf(user), muted: Boolean(room.participants.get(user.id)?.muted) },
        items: room.boardItems().map(publicItem),
        budget: room.budget(),
        participants: room.participantList(),
        onlineCount: room.presence.size,
        leader: room.leaderStatus(),
        conflicts: room.conflicts.map((c) => ({ ...c, status: 'open' })),
        votes: [...room.votes.values()].map(publicVote),
        chat: socket.data.chat.map((m) => messageView(m, room.names)),
        serverTime: Date.now(),
      }),
    );
    socket.data.chat = null;

    if (newPresence) {
      socket.to(tripId).emit(
        'trip.presence.update',
        envelope('trip.presence.update', tripId, {
          participantId: user.id,
          displayName: room.names.get(user.id) ?? user.name,
          action: 'joined',
          participantCount: room.presence.size,
          memberCount: room.participants.size,
        }),
      );
      log.info('presence.joined', { tripId, correlationId: room.correlationId, userId: user.id });
    }
    if (!leaderWasConnected && room.leaderConnected) {
      emitRoom(room, 'trip.leader.status', room.leaderStatus());
    }

    const on = makeHandler({ socket, getRoom: () => registry.get(tripId) });

    // ---- latency ---------------------------------------------------------
    socket.on('trip.sync.ping', (msg = {}) => {
      const serverReceivedAt = Date.now();
      const clientSentAt = Number(msg?.payload?.clientSentAt) || null;
      socket.emit('trip.sync.pong', envelope('trip.sync.pong', tripId, { clientSentAt, serverReceivedAt }));
    });

    on('trip.sync.report', { schema: schemas.syncReport }, ({ payload, room: r }) => {
      const live = r.presence.get(user.id);
      if (!live) return {};
      const quality = qualityOf(payload.rttMs);
      const changed = quality !== live.quality;
      live.rttMs = Math.round(payload.rttMs);
      live.quality = quality;
      if (changed) {
        emitRoom(r, 'trip.presence.quality', { participantId: user.id, rttMs: live.rttMs, quality });
      }
      return { quality };
    });

    // Lets a long-lived socket swap in a fresh access token without reconnecting.
    on('auth.renew', { schema: schemas.authRenew }, ({ payload }) => {
      const claims = verifyAccessToken(payload.token, config);
      if (claims.id !== user.id) throw unauthorized('Token belongs to a different account', 'INVALID_TOKEN');
      socket.data.user = { ...socket.data.user, tokenExp: claims.exp };
      return { expiresAt: claims.exp };
    });

    // ---- board -----------------------------------------------------------
    const boardUpdate = (r, action, item, byUserId) =>
      emitRoom(r, 'trip.board.update', { action, ...publicItem(item), item: publicItem(item), byUserId });

    const refuse = (result) => {
      if (result.code === ERR.VERSION_CONFLICT) {
        // Spec 6.1: the losing client gets an explicit conflict notice with the truth.
        socket.emit(
          'trip.board.rejected',
          envelope('trip.board.rejected', tripId, {
            itemId: String(result.current._id),
            reason: result.code,
            message: result.message,
            current: publicItem(result.current),
          }),
        );
      }
      throw new BoardError({ ...result, current: result.current ? publicItem(result.current) : undefined });
    };

    on('trip.board.pin', { schema: schemas.pin, min: 'planner' }, ({ payload, room: r }) => {
      const venue = r.venues.get(payload.venueId);
      if (!venue) throw notFound(`Venue ${payload.venueId} is not in this trip's destination`);
      const result = pinItem(
        r.items,
        {
          id: new mongoose.Types.ObjectId(),
          tripId: new mongoose.Types.ObjectId(r.tripId),
          venueId: venue.venueId,
          venue: {
            name: venue.name,
            category: venue.category,
            neighborhood: venue.neighborhood,
            pricePerPerson: venue.pricePerPerson,
            coordinates: venue.coordinates,
            hours: venue.hours,
            dietaryTags: venue.dietaryTags,
          },
          dayIndex: payload.dayIndex,
          startTime: payload.startTime,
          endTime: payload.endTime,
          userId: user.id,
        },
        r.trip.dayCount,
      );
      if (!result.ok) refuse(result);
      boardUpdate(r, 'pinned', result.item, user.id);
      emitRoom(r, 'trip.budget.update', r.budget());
      r.markDirty(result.item._id, { immediate: true });
      actions.afterBoardChange(r);
      return { item: publicItem(result.item) };
    });

    on('trip.board.move', { schema: schemas.move, min: 'planner' }, ({ payload, room: r }) => {
      const result = moveItem(r.items, payload, r.trip.dayCount);
      if (!result.ok) refuse(result);
      boardUpdate(r, 'moved', result.item, user.id);
      r.markDirty(result.item._id); // batched (spec 9.4: not on every micro-move)
      actions.afterBoardChange(r);
      return { item: publicItem(result.item) };
    });

    on('trip.board.remove', { schema: schemas.remove, min: 'planner' }, ({ payload, room: r }) => {
      const result = removeItem(r.items, payload);
      if (!result.ok) refuse(result);
      emitRoom(r, 'trip.board.update', {
        action: 'removed',
        itemId: String(result.item._id),
        positionVersion: result.item.positionVersion,
        byUserId: user.id,
      });
      emitRoom(r, 'trip.budget.update', r.budget());
      r.markDeleted(result.item._id);
      actions.afterBoardChange(r);
      return { itemId: String(result.item._id) };
    });

    on(
      'trip.board.lock',
      { schema: schemas.lock, min: 'leader', sensitive: true, frozen: true },
      ({ payload, room: r }) => {
        const result = lockItem(r.items, { itemId: payload.itemId, userId: user.id });
        if (!result.ok) refuse(result);
        boardUpdate(r, 'locked', result.item, user.id);
        r.markDirty(result.item._id, { immediate: true });
        return { item: publicItem(result.item) };
      },
    );

    // Leader override of a finalised item.
    on(
      'trip.board.unlock',
      { schema: schemas.lock, min: 'leader', sensitive: true, frozen: true },
      ({ payload, room: r }) => {
        const result = unlockItem(r.items, payload);
        if (!result.ok) refuse(result);
        boardUpdate(r, 'unlocked', result.item, user.id);
        r.markDirty(result.item._id, { immediate: true });
        return { item: publicItem(result.item) };
      },
    );

    // ---- chat ------------------------------------------------------------
    on('trip.chat.send', { schema: schemas.chatSend, notMuted: true }, async ({ payload, room: r }) => {
      const body = sanitizeChat(payload.body);
      if (!body) throw badRequest('Message is empty');
      if (body.length > MAX_CHAT_LENGTH) throw badRequest(`Messages can be at most ${MAX_CHAT_LENGTH} characters`);
      const { doc, duplicate } = await saveMessage({
        tripId: r.tripId,
        userId: user.id,
        body,
        clientMsgId: payload.clientMsgId ?? null,
      });
      const view = messageView(doc, r.names);
      if (!duplicate) emitRoom(r, 'trip.chat.message', view);
      return { message: view, duplicate };
    });

    on('trip.chat.typing', { schema: schemas.chatTyping, notMuted: true }, ({ payload, room: r }) => {
      socket.to(r.tripId).emit(
        'trip.chat.typing',
        envelope('trip.chat.typing', r.tripId, {
          userId: user.id,
          displayName: r.names.get(user.id) ?? user.name,
          isTyping: payload.isTyping,
        }),
      );
    });

    on('trip.chat.react', { schema: schemas.chatReact }, async ({ payload, room: r }) => {
      const doc = await toggleReaction({ tripId: r.tripId, messageId: payload.messageId, userId: user.id, emoji: payload.emoji });
      if (!doc) throw notFound('Message not found');
      const { reactions } = messageView(doc, r.names);
      emitRoom(r, 'trip.chat.reaction', { messageId: payload.messageId, reactions });
      return { reactions };
    });

    on('trip.chat.history', { schema: schemas.chatHistory }, async ({ payload, room: r }) => {
      const docs = await history(r.tripId, payload);
      return { messages: docs.map((m) => messageView(m, r.names)) };
    });

    // ---- leader moderation (spec 6.1) -------------------------------------
    const system = async (r, body, meta) => {
      const { doc } = await saveMessage({ tripId: r.tripId, type: 'system', body, meta });
      emitRoom(r, 'trip.chat.message', messageView(doc, r.names));
    };

    const targetOf = (r, userId) => {
      if (!r.participants.has(userId)) throw notFound('That person is not in this trip');
      if (userId === user.id) throw badRequest('You cannot do this to yourself');
      return r.participants.get(userId);
    };
    const nameOf = (r, id) => r.names.get(id) ?? 'A traveller';

    on('trip.mod.mute', { schema: schemas.mute, min: 'leader', sensitive: true }, async ({ payload, room: r }) => {
      targetOf(r, payload.userId);
      if (payload.userId === r.trip.leaderUserId) throw forbidden('The trip leader cannot be muted');
      await Trip.updateOne(
        { _id: r.tripId, 'participants.userId': payload.userId },
        { $set: { 'participants.$.muted': payload.muted } },
      );
      r.participants.get(payload.userId).muted = payload.muted;
      emitRoom(r, 'trip.participant.updated', { userId: payload.userId, muted: payload.muted, byUserId: user.id });
      await system(r, `${nameOf(r, payload.userId)} was ${payload.muted ? 'muted' : 'unmuted'} by the trip leader`, {
        action: payload.muted ? 'muted' : 'unmuted',
        userId: payload.userId,
      });
      return {};
    });

    on(
      'trip.mod.remove',
      { schema: schemas.removeParticipant, min: 'leader', sensitive: true },
      async ({ payload, room: r }) => {
        targetOf(r, payload.userId);
        if (payload.userId === r.trip.leaderUserId) throw forbidden('Transfer the leader role before removing them');
        const name = nameOf(r, payload.userId);
        await Trip.updateOne(
          { _id: r.tripId },
          { $pull: { participants: { userId: payload.userId } }, $addToSet: { removedUserIds: payload.userId } },
        );
        r.participants.delete(payload.userId);

        // Kick every connection that person has open in this room.
        const sockets = await nsp.in(r.tripId).fetchSockets();
        for (const s of sockets) {
          if (s.data.user?.id === payload.userId) {
            s.emit('trip.participant.removed', envelope('trip.participant.removed', r.tripId, { byUserId: user.id }));
            s.data.removed = true;
            s.disconnect(true);
          }
        }
        finalizeLeave(r, payload.userId, { force: true });
        emitRoom(r, 'trip.participant.updated', { userId: payload.userId, removed: true, byUserId: user.id });
        emitRoom(r, 'trip.budget.update', r.budget());
        actions.checkConflicts(r);
        await system(r, `${name} was removed from the trip`, { action: 'removed', userId: payload.userId });
        return {};
      },
    );

    on('trip.mod.lockRoom', { schema: schemas.lockRoom, min: 'leader', sensitive: true }, async ({ payload, room: r }) => {
      await Trip.updateOne({ _id: r.tripId }, { roomLocked: payload.locked });
      r.trip.roomLocked = payload.locked;
      emitRoom(r, 'trip.room.locked', { locked: payload.locked, byUserId: user.id });
      await system(r, payload.locked ? 'The room was locked: no new travellers can join' : 'The room was unlocked', {
        action: payload.locked ? 'room_locked' : 'room_unlocked',
      });
      return {};
    });

    on(
      'trip.mod.transferLeader',
      { schema: schemas.transferLeader, min: 'leader', sensitive: true },
      async ({ payload, room: r }) => {
        const oldLeader = r.trip.leaderUserId;
        if (payload.userId === oldLeader) throw badRequest('That person is already the leader');
        if (!r.participants.has(payload.userId)) throw notFound('That person is not in this trip');
        await Trip.updateOne(
          { _id: r.tripId },
          {
            $set: {
              leaderUserId: payload.userId,
              'participants.$[old].role': 'planner',
              'participants.$[neu].role': 'leader',
              'participants.$[neu].muted': false,
            },
          },
          { arrayFilters: [{ 'old.userId': new mongoose.Types.ObjectId(oldLeader) }, { 'neu.userId': new mongoose.Types.ObjectId(payload.userId) }] },
        );
        await r.reloadTrip();
        if (!r.leaderConnected) r.leaderAwaySince = Date.now();
        emitRoom(r, 'trip.participant.updated', { userId: oldLeader, role: 'planner', byUserId: user.id });
        emitRoom(r, 'trip.participant.updated', { userId: payload.userId, role: 'leader', byUserId: user.id });
        emitRoom(r, 'trip.leader.status', r.leaderStatus());
        await system(r, `${nameOf(r, payload.userId)} is now the trip leader`, {
          action: 'leader_transferred',
          from: oldLeader,
          to: payload.userId,
        });
        return {};
      },
    );

    // ---- contested-slot voting (spec 6.2) ---------------------------------
    const voteFail = (result) => {
      throw new HttpError(result.code === 'VOTE_NOT_FOUND' ? 404 : 409, result.code, result.message);
    };

    on('trip.vote.open', { schema: schemas.voteOpen, min: 'leader' }, ({ payload, room: r }) => {
      const result = actions.startVote(r, {
        itemIds: payload.itemIds,
        openedByUserId: user.id,
        durationSeconds: payload.durationSeconds ?? config.voteSeconds,
      });
      if (!result.ok) voteFail(result);
      return { vote: result.vote };
    });

    // Viewers vote too: spec 5.1 lets the leader give some people "vote only".
    on('trip.vote.cast', { schema: schemas.voteCast }, ({ payload, room: r }) => {
      const result = actions.cast(r, { voteId: payload.voteId, userId: user.id, itemId: payload.itemId });
      if (!result.ok) voteFail(result);
      return { vote: result.vote };
    });

    on('trip.vote.cancel', { schema: schemas.voteCancel, min: 'leader', sensitive: true }, ({ payload, room: r }) => {
      const result = actions.cancel(r, payload.voteId);
      if (!result.ok) voteFail(result);
      return {};
    });

    // ---- AI Concierge ------------------------------------------------------
    on('trip.ai.ask', { schema: schemas.aiAsk }, async ({ payload, room: r }) => ({ result: await ask(r, user, payload) }));

    // ---- leaving -----------------------------------------------------------
    socket.on('disconnect', () => {
      const r = registry.get(tripId);
      if (!r) return;
      const live = r.presence.get(user.id);
      if (!live) return;
      live.sockets.delete(socket.id);
      if (live.sockets.size === 0 && !live.leaveTimer) {
        if (socket.data.removed) return; // already handled by trip.mod.remove
        live.leaveTimer = setTimeout(() => finalizeLeave(r, user.id), config.presenceGraceMs);
      }
    });
  });

  // Called when a traveller's last connection has been gone for the grace period
  // (or immediately when they are removed).
  function finalizeLeave(room, userId, { force = false } = {}) {
    const live = room.presence.get(userId);
    if (!live) return;
    if (!force && live.sockets.size > 0) return;
    clearTimeout(live.leaveTimer);
    const wasLeader = userId === room.trip.leaderUserId;
    room.presence.delete(userId);
    emitRoom(room, 'trip.presence.update', {
      participantId: userId,
      displayName: room.names.get(userId) ?? 'Traveller',
      action: 'left',
      participantCount: room.presence.size,
      memberCount: room.participants.size,
    });
    log.info('presence.left', { tripId: room.tripId, correlationId: room.correlationId, userId });
    if (wasLeader) {
      // Spec 6.1: clearly indicated "leader disconnected" state; lock/unlock frozen.
      room.leaderAwaySince = Date.now();
      emitRoom(room, 'trip.leader.status', room.leaderStatus());
    }
    if (room.presence.size === 0 && room.pendingJoins === 0) registry.close(room.tripId);
  }

  // REST changes (someone joined, a role or setting changed) refresh the live room.
  const onTripChanged = async ({ tripId }) => {
    const room = registry.get(tripId);
    if (!room) return;
    try {
      await room.reloadTrip();
      emitRoom(room, 'trip.participants.update', { participants: room.participantList(), budget: room.budget() });
      actions.checkConflicts(room);
    } catch (err) {
      log.error('room.reload_failed', { tripId, error: err.message });
    }
  };
  bus.on(TRIP_CHANGED, onTripChanged);

  // A traveller changed their dietary needs or budget ceiling.
  const onUserChanged = async ({ userId }) => {
    for (const room of registry.rooms.values()) {
      if (!room.participants.has(userId)) continue;
      try {
        await room.loadNames();
        emitRoom(room, 'trip.participants.update', { participants: room.participantList(), budget: room.budget() });
        actions.checkConflicts(room);
      } catch (err) {
        log.error('room.reload_failed', { tripId: room.tripId, error: err.message });
      }
    }
  };
  bus.on(USER_CHANGED, onUserChanged);

  return {
    nsp,
    dispose: () => {
      bus.off(TRIP_CHANGED, onTripChanged);
      bus.off(USER_CHANGED, onUserChanged);
    },
  };
}
