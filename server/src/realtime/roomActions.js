import mongoose from 'mongoose';
import { detectConflicts, diffConflicts } from '../concierge/conflicts.js';
import { openVote, castBallot, resolveVote, cancelVote, publicVote, openSplitVote, castSplitBallot, decideSplitVote } from '../board/votes.js';
import { publicItem, setSharing } from '../board/boardState.js';
import { saveMessage, messageView } from '../chat/chatService.js';
import { log } from '../lib/logger.js';

// Room-level actions that both the WebSocket handlers and the REST API use:
// conflict detection after board changes, and contested-slot votes.
// `emit(room, event, payload)` broadcasts an enveloped event to the room.
export function roomActions({ emit, config }) {
  async function post(room, type, body, meta) {
    const { doc } = await saveMessage({ tripId: room.tripId, type, body, meta });
    emit(room, 'trip.chat.message', messageView(doc, room.names));
  }

  const conflictInput = (room) => ({
    items: [...room.items.values()],
    participantIds: room.participantIds,
    travellers: room.travellers,
    names: room.names,
    totalBudget: room.trip.totalBudget,
  });

  // Re-runs the detector and announces conflicts that appeared or went away.
  // Synchronous up to the broadcast, so a flag reaches the room in
  // milliseconds (spec 6.2: within 1 second).
  function checkConflicts(room) {
    const current = detectConflicts(conflictInput(room));
    const { opened, resolved } = diffConflicts(room.conflicts, current);
    room.conflicts = current;
    const detectedAt = new Date().toISOString();
    for (const c of opened) {
      emit(room, 'trip.board.conflict', { ...c, status: 'open', detectedAt });
      room.logEvent('conflict_opened', { conflictId: c.conflictId, conflictType: c.conflictType, itemIds: c.itemIds });
      log.info('conflict.opened', { tripId: room.tripId, correlationId: room.correlationId, conflictId: c.conflictId });
      post(room, 'conflict', c.details.message, { conflictId: c.conflictId, conflictType: c.conflictType, status: 'open', itemIds: c.itemIds }).catch(
        (err) => log.error('conflict.post_failed', { tripId: room.tripId, error: err.message }),
      );
    }
    for (const c of resolved) {
      emit(room, 'trip.board.conflictResolved', { conflictId: c.conflictId, conflictType: c.conflictType, itemIds: c.itemIds, resolvedAt: detectedAt });
      room.logEvent('conflict_resolved', { conflictId: c.conflictId, conflictType: c.conflictType });
      log.info('conflict.resolved', { tripId: room.tripId, correlationId: room.correlationId, conflictId: c.conflictId });
      post(room, 'system', `Resolved: ${c.details.message}`, { conflictId: c.conflictId, conflictType: c.conflictType, status: 'resolved' }).catch(
        (err) => log.error('conflict.post_failed', { tripId: room.tripId, error: err.message }),
      );
    }
    return { opened, resolved };
  }

  // The system opens a vote by itself when two drafting items are pinned to
  // exactly the same slot (same day, same start time).
  function autoVote(room) {
    const groups = new Map();
    for (const item of room.items.values()) {
      if (item.lifecycleStage !== 'drafting') continue;
      const key = `${item.dayIndex}@${item.startTime}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const group of groups.values()) {
      if (group.length >= 2) {
        startVote(room, { itemIds: group.map((i) => String(i._id)), openedByUserId: null, durationSeconds: config.voteSeconds });
      }
    }
  }

  // Run after every board change.
  function afterBoardChange(room) {
    autoVote(room);
    checkConflicts(room);
  }

  function scheduleClose(room, vote) {
    clearTimeout(room.voteTimers.get(String(vote._id)));
    const ms = Math.max(0, new Date(vote.closesAt) - Date.now());
    const timer = setTimeout(() => finishVote(room, String(vote._id)), ms);
    timer.unref?.();
    room.voteTimers.set(String(vote._id), timer);
  }

  function startVote(room, { itemIds, openedByUserId, durationSeconds }) {
    const voteId = new mongoose.Types.ObjectId();
    const closesAt = new Date(Date.now() + durationSeconds * 1000);
    const result = openVote(room.items, { voteId, itemIds, openedByUserId, closesAt });
    if (!result.ok) return result;
    room.votes.set(String(voteId), result.vote);
    for (const item of result.items) {
      emit(room, 'trip.board.update', { action: 'voting', ...publicItem(item), item: publicItem(item), byUserId: openedByUserId });
      room.markDirty(item._id, { immediate: true });
    }
    room.saveVote(result.vote);
    scheduleClose(room, result.vote);
    room.logEvent('vote_opened', { userId: openedByUserId, kind: 'slot', voteId: String(voteId), itemIds: result.vote.itemIds });
    const view = publicVote(result.vote);
    // Spec 7.3.4 shape (itemId, candidateVenueIds, closesAt) plus the full vote.
    emit(room, 'trip.vote.open', { itemId: view.itemIds[0], ...view });
    post(
      room,
      'system',
      `${openedByUserId ? `${room.names.get(String(openedByUserId)) ?? 'The leader'} opened` : 'Two items share a slot, so the system opened'} a vote: ${result.vote.candidates.map((c) => c.name).join(' vs ')}`,
      { voteId: String(voteId), action: 'vote_opened' },
    ).catch(() => {});
    log.info('vote.opened', { tripId: room.tripId, correlationId: room.correlationId, voteId: String(voteId), system: !openedByUserId });
    return { ok: true, vote: view };
  }

  function cast(room, { voteId, userId, itemId }) {
    const vote = room.votes.get(voteId);
    if (!vote) return { ok: false, code: 'VOTE_NOT_FOUND', message: 'No open vote with that id' };
    if (vote.kind === 'split') return { ok: false, code: 'WRONG_VOTE_KIND', message: 'This is a budget-split vote; use trip.split.cast' };
    const result = castBallot(vote, { userId, itemId });
    if (!result.ok) return result;
    room.saveVote(vote);
    room.logEvent('vote_cast', { userId, kind: 'slot', voteId, choice: String(itemId), changed: result.changed });
    const chosen = vote.candidates.find((c) => c.itemId === String(itemId));
    if (chosen) room.logInteraction(userId, chosen.venueId, { liked: true, weight: 1, source: 'vote' });
    const view = publicVote(vote);
    const choice = vote.candidates.find((c) => c.itemId === String(itemId));
    emit(room, 'trip.vote.cast', {
      voteId,
      itemId: String(itemId),
      userId,
      choiceVenueId: choice.venueId,
      changed: result.changed,
      ballotCount: view.ballotCount,
      tally: view.tally,
    });
    // Everyone in the trip has voted: no need to wait for the timer.
    if (vote.ballots.size >= room.participants.size) finishVote(room, voteId);
    return { ok: true, vote: publicVote(vote) };
  }

  // Applies the winner identically for every client: one resolution, one broadcast.
  function finishVote(room, voteId) {
    const vote = room.votes.get(voteId);
    if (!vote || vote.status !== 'open') return null;
    if (vote.kind === 'split') return finishSplitVote(room, voteId);
    clearTimeout(room.voteTimers.get(voteId));
    room.voteTimers.delete(voteId);
    const result = resolveVote(room.items, vote);
    room.votes.delete(voteId);
    if (!result.ok) {
      vote.status = 'cancelled';
      room.saveVote(vote);
      return null;
    }
    emit(room, 'trip.board.update', { action: 'vote_won', ...publicItem(result.winner), item: publicItem(result.winner), byUserId: null });
    room.markDirty(result.winner._id, { immediate: true });
    for (const r of result.removed) {
      emit(room, 'trip.board.update', { action: 'removed', itemId: String(r._id), positionVersion: r.positionVersion, byUserId: null, reason: 'lost_vote' });
      room.markDeleted(r._id);
    }
    room.saveVote(vote);
    emit(room, 'trip.vote.resolved', {
      voteId,
      itemId: String(result.winner._id),
      winningVenueId: result.winner.venueId,
      tally: result.tally,
      resolution: result.resolution,
      removedItemIds: result.removed.map((r) => String(r._id)),
    });
    emit(room, 'trip.budget.update', room.budget());
    const label = { votes: 'by vote', tie_earliest_pin: 'on a tie (first pinned wins)', no_votes_earliest_pin: 'with no votes (first pinned wins)' };
    post(room, 'system', `Vote closed: ${result.winner.venue.name} won ${label[result.resolution]}`, {
      voteId,
      action: 'vote_resolved',
      winnerItemId: String(result.winner._id),
      tally: result.tally,
    }).catch(() => {});
    log.info('vote.resolved', { tripId: room.tripId, correlationId: room.correlationId, voteId, resolution: result.resolution });
    room.logEvent('vote_resolved', {
      kind: 'slot',
      voteId,
      winnerItemId: String(result.winner._id),
      winningVenueId: result.winner.venueId,
      removedItemIds: result.removed.map((r) => String(r._id)),
      tally: result.tally,
      resolution: result.resolution,
    });
    checkConflicts(room);
    return result;
  }

  // ---- budget-split votes ---------------------------------------------------

  function startSplitVote(room, { itemId, proposal, openedByUserId, durationSeconds }) {
    const voteId = new mongoose.Types.ObjectId();
    const closesAt = new Date(Date.now() + durationSeconds * 1000);
    const result = openSplitVote(room.items, { voteId, itemId, proposal, openedByUserId, closesAt });
    if (!result.ok) return result;
    room.votes.set(String(voteId), result.vote);
    room.saveVote(result.vote);
    scheduleClose(room, result.vote);
    room.logEvent('vote_opened', { userId: openedByUserId, itemId, kind: 'split', voteId: String(voteId), proposal });
    const view = publicVote(result.vote);
    emit(room, 'trip.split.open', view);
    post(
      room,
      'system',
      `${room.names.get(String(openedByUserId)) ?? 'Someone'} proposed a new cost split for ${result.item.venue.name}. Vote yes or no.`,
      { voteId: String(voteId), action: 'split_vote_opened' },
    ).catch(() => {});
    return { ok: true, vote: view };
  }

  function castSplit(room, { voteId, userId, choice }) {
    const vote = room.votes.get(voteId);
    if (!vote) return { ok: false, code: 'VOTE_NOT_FOUND', message: 'No open vote with that id' };
    if (vote.kind !== 'split') return { ok: false, code: 'WRONG_VOTE_KIND', message: 'This is a slot vote; use trip.vote.cast' };
    const result = castSplitBallot(vote, { userId, choice });
    if (!result.ok) return result;
    room.saveVote(vote);
    room.logEvent('vote_cast', { userId, itemId: vote.itemIds[0], kind: 'split', voteId, choice, changed: result.changed });
    const view = publicVote(vote);
    emit(room, 'trip.split.cast', { voteId, userId, choice, changed: result.changed, ballotCount: view.ballotCount, tally: view.tally });
    if (vote.ballots.size >= room.participants.size) finishSplitVote(room, voteId);
    return { ok: true, vote: publicVote(vote) };
  }

  // Yes beats no -> the proposal is applied (if the item hasn't changed meanwhile).
  function finishSplitVote(room, voteId) {
    const vote = room.votes.get(voteId);
    if (!vote || vote.status !== 'open') return null;
    clearTimeout(room.voteTimers.get(voteId));
    room.voteTimers.delete(voteId);
    room.votes.delete(voteId);
    const decision = decideSplitVote(room.items, vote);
    let applied = false;
    if (decision.apply) {
      const r = setSharing(
        room.items,
        { itemId: vote.itemIds[0], ...vote.proposal, expectedVersion: vote.expectedVersion },
        room.participantIds,
      );
      if (r.ok) {
        applied = true;
        emit(room, 'trip.board.update', { action: 'sharing_changed', ...publicItem(r.item), item: publicItem(r.item), byUserId: null });
        room.markDirty(r.item._id, { immediate: true });
        emit(room, 'trip.budget.update', room.budget());
        room.logEvent('sharing_changed', { itemId: r.item._id, via: 'vote', attendeeIds: r.item.attendeeIds.map(String), split: r.item.split });
      } else {
        vote.resolution = 'item_changed';
      }
    }
    room.saveVote(vote);
    room.logEvent('vote_resolved', { itemId: vote.itemIds[0], kind: 'split', voteId, applied, tally: decision.tally, resolution: vote.resolution });
    emit(room, 'trip.split.resolved', { voteId, itemId: vote.itemIds[0], applied, tally: decision.tally, resolution: vote.resolution });
    const label = {
      majority_yes: 'approved',
      majority_no: 'rejected',
      tie_keeps_current: 'tied, so nothing changed',
      item_changed: 'dropped because the item changed meanwhile',
    };
    post(
      room,
      'system',
      `Cost split vote for ${vote.candidates[0].name}: ${label[vote.resolution]} (${decision.tally.yes} yes, ${decision.tally.no} no)`,
      { voteId, action: 'split_vote_resolved' },
    ).catch(() => {});
    if (applied) checkConflicts(room);
    return decision;
  }


  function cancel(room, voteId) {
    const vote = room.votes.get(voteId);
    if (!vote) return { ok: false, code: 'VOTE_NOT_FOUND', message: 'No open vote with that id' };
    clearTimeout(room.voteTimers.get(voteId));
    room.voteTimers.delete(voteId);
    const result =
      vote.kind === 'split'
        ? (Object.assign(vote, { status: 'cancelled', resolvedAt: new Date() }), { restored: [] })
        : cancelVote(room.items, vote);
    room.votes.delete(voteId);
    for (const item of result.restored) {
      emit(room, 'trip.board.update', { action: 'vote_cancelled', ...publicItem(item), item: publicItem(item), byUserId: null });
      room.markDirty(item._id, { immediate: true });
    }
    room.saveVote(vote);
    room.logEvent('vote_cancelled', { kind: vote.kind ?? 'slot', voteId });
    emit(room, 'trip.vote.cancelled', { voteId });
    return { ok: true };
  }

  // A room was (re)loaded from the database: restore vote timers and take a
  // silent baseline of current conflicts (so reloading doesn't re-announce them).
  function onRoomOpen(room) {
    for (const vote of room.votes.values()) scheduleClose(room, vote);
    room.conflicts = detectConflicts(conflictInput(room));
  }

  return { afterBoardChange, checkConflicts, startVote, cast, finishVote, cancel, onRoomOpen, startSplitVote, castSplit };
}
