import crypto from 'node:crypto';
import { ItineraryItem } from './itineraryItem.model.js';
import { Trip } from '../trips/trip.model.js';
import { User } from '../auth/user.model.js';
import { venuesFor, findDestination } from '../venues/catalog.js';
import { Vote } from './vote.model.js';
import { TripEvent } from './tripEvent.model.js';
import { Interaction } from '../recs/interaction.model.js';
import { computeBudget, budgetPanel } from './budgetEngine.js';
import { sortedItems } from './boardState.js';
import { log } from '../lib/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const strip = ({ _id, date, month, ...rest }) => rest;
const dayCountOf = (trip) =>
  (Date.parse(`${trip.endDate}T00:00:00Z`) - Date.parse(`${trip.startDate}T00:00:00Z`)) / DAY_MS + 1;

// One live Trip Room. Holds the authoritative in-flight board in memory
// (spec 9.4) and saves it to MongoDB in the background:
//  - significant changes (pin, remove, lock, unlock) are saved immediately,
//  - moves are batched and saved at most every `flushIntervalMs`.
// Saves are serialised through one promise chain, so they land in order.
export class Room {
  constructor({ trip, items, venues, names, flushIntervalMs, weather = null, votes = [] }) {
    this.tripId = String(trip._id);
    this.correlationId = `room_${this.tripId.slice(-6)}_${crypto.randomBytes(3).toString('hex')}`;
    this.items = new Map(items.map((i) => [String(i._id), i]));
    this.venues = venues; // Map venueId -> venue (this destination only)
    this.names = names; // Map userId -> displayName
    this.travellers = new Map(); // userId -> { dietaryTags, budgetCeiling }
    this.weather = weather; // { monthly, daily } for the destination
    this.votes = new Map(votes.map((v) => [String(v._id), v])); // open votes
    this.voteTimers = new Map();
    this.conflicts = []; // current conflicts (see concierge/conflicts.js)
    this.eventBuffer = []; // event log rows waiting to be saved
    this.interactionBuffer = []; // recommendation signals waiting to be saved
    this.lastSeq = 0;
    this.flushIntervalMs = flushIntervalMs;
    // userId -> { sockets: Set<socketId>, rttMs, quality, leaveTimer }
    this.presence = new Map();
    this.pendingJoins = 0; // handshakes in progress
    this.leaderAwaySince = Date.now();
    this.dirty = new Set();
    this.deleted = new Set();
    this.flushTimer = null;
    this.saving = Promise.resolve();
    this.setTrip(trip);
  }

  // Cache of the trip fields the gateway checks on every event.
  setTrip(trip) {
    this.trip = {
      destination: trip.destination,
      destinationName: trip.destinationName,
      startDate: trip.startDate,
      endDate: trip.endDate,
      dayCount: dayCountOf(trip),
      totalBudget: trip.totalBudget,
      leaderUserId: String(trip.leaderUserId),
      roomLocked: Boolean(trip.roomLocked),
      status: trip.status,
    };
    this.participants = new Map(
      trip.participants.map((p) => [String(p.userId), { role: p.role, muted: Boolean(p.muted), joinedAt: p.joinedAt }]),
    );
  }

  // Re-reads the trip. Names are only re-fetched when someone joined or left.
  async reloadTrip() {
    const trip = await Trip.findById(this.tripId);
    if (!trip) return null;
    const before = [...this.participants.keys()].sort().join();
    this.setTrip(trip);
    if ([...this.participants.keys()].sort().join() !== before) await this.loadNames();
    return trip;
  }

  // Names and declared preferences of everyone in the trip.
  async loadNames() {
    const ids = [...this.participants.keys()];
    const users = await User.find({ _id: { $in: ids } }).select('displayName preferences').lean();
    this.names = new Map(users.map((u) => [String(u._id), u.displayName]));
    this.travellers = new Map(
      users.map((u) => [
        String(u._id),
        { dietaryTags: u.preferences?.dietaryTags ?? [], budgetCeiling: u.preferences?.budgetCeiling ?? null },
      ]),
    );
  }

  get participantIds() {
    return [...this.participants.keys()];
  }

  // Forecast for a trip day: the daily forecast if there is one, else the
  // month's normal. Returns null when there is no weather data.
  weatherFor(dayIndex) {
    if (dayIndex == null || !this.weather) return null;
    const date = new Date(Date.parse(`${this.trip.startDate}T00:00:00Z`) + dayIndex * DAY_MS).toISOString().slice(0, 10);
    const daily = this.weather.daily?.find((d) => d.date === date);
    if (daily) return { date, source: 'forecast', ...strip(daily) };
    const month = Number(date.slice(5, 7));
    const normal = this.weather.monthly?.find((m) => m.month === month);
    return normal ? { date, source: 'monthly_normal', ...strip(normal) } : null;
  }

  // Saves a vote (whole document), in order with the item saves.
  saveVote(vote) {
    const doc = {
      _id: vote._id,
      tripId: this.tripId,
      kind: vote.kind ?? 'slot',
      proposal: vote.proposal ?? null,
      expectedVersion: vote.expectedVersion ?? null,
      itemIds: vote.itemIds,
      candidates: vote.candidates,
      openedByUserId: vote.openedByUserId,
      closesAt: vote.closesAt,
      ballots: Object.fromEntries(vote.ballots),
      status: vote.status,
      winnerItemId: vote.winnerItemId ?? null,
      winningVenueId: vote.winningVenueId ?? null,
      tally: vote.tally ?? {},
      resolvedAt: vote.resolvedAt ?? null,
      resolution: vote.resolution ?? null,
    };
    this.saving = this.saving.then(() =>
      Vote.replaceOne({ _id: vote._id }, doc, { upsert: true }).catch((err) =>
        log.error('vote.save_failed', { tripId: this.tripId, correlationId: this.correlationId, error: err.message }),
      ),
    );
    return this.saving;
  }

  async reloadVenues() {
    const [venues, destination] = await Promise.all([venuesFor(this.trip.destination), findDestination(this.trip.destination)]);
    this.venues = new Map(venues.map((v) => [v._id, v.toPublic()]));
    this.weather = destination?.weather ?? null;
  }

  // Role in this room from the cache: 'admin' | 'leader' | 'planner' | 'viewer' | null.
  roleOf(user) {
    if (user.role === 'admin') return 'admin';
    return this.participants.get(user.id)?.role ?? null;
  }

  get leaderConnected() {
    return this.presence.has(this.trip.leaderUserId);
  }

  leaderStatus() {
    return {
      leaderUserId: this.trip.leaderUserId,
      connected: this.leaderConnected,
      awaySince: this.leaderConnected ? null : new Date(this.leaderAwaySince).toISOString(),
      frozenActions: this.leaderConnected ? [] : ['lock', 'unlock'],
    };
  }

  // Full budget (cents, per-item shares, running totals) from the engine.
  fullBudget() {
    return computeBudget({
      items: this.boardItems(),
      participantIds: this.participantIds,
      totalBudget: this.trip.totalBudget,
      ceilings: new Map([...this.travellers].map(([id, t]) => [id, t.budgetCeiling])),
    });
  }

  // Compact figures for the live budget panel.
  budget() {
    return budgetPanel(this.fullBudget(), this.participants.size, this.items.size);
  }

  participantList() {
    return [...this.participants.entries()].map(([userId, p]) => {
      const live = this.presence.get(userId);
      return {
        userId,
        displayName: this.names.get(userId) ?? 'Traveller',
        role: p.role,
        muted: p.muted,
        online: Boolean(live),
        connections: live ? live.sockets.size : 0,
        rttMs: live?.rttMs ?? null,
        quality: live?.quality ?? null,
      };
    });
  }

  boardItems() {
    return sortedItems(this.items);
  }

  // ---- event log ----------------------------------------------------------

  // Adds one row to the trip's event log (saved with the next flush).
  // `seq` is strictly increasing, so the order is exact even within one millisecond.
  logEvent(type, { userId = null, itemId = null, ...data } = {}) {
    const now = Date.now();
    this.lastSeq = Math.max(now * 1000, this.lastSeq + 1);
    this.eventBuffer.push({
      tripId: this.tripId,
      seq: this.lastSeq,
      type,
      userId: userId ? String(userId) : null,
      itemId: itemId ? String(itemId) : null,
      data,
      ts: new Date(now),
    });
    this.scheduleFlush(false);
  }

  // A taste signal for the recommendation engine (saved with the next flush).
  logInteraction(userId, venueId, { liked, weight = 1, source }) {
    const venue = this.venues.get(venueId);
    if (!venue || !userId) return;
    this.interactionBuffer.push({
      userId: String(userId),
      tripId: this.tripId,
      destination: this.trip.destination,
      venueId,
      category: venue.category,
      liked,
      weight,
      source,
      coTraveledWith: this.participantIds.filter((id) => id !== String(userId)),
      createdAt: new Date(),
    });
    this.scheduleFlush(false);
  }

  // ---- persistence ----------------------------------------------------

  markDirty(itemId, { immediate = false } = {}) {
    this.dirty.add(String(itemId));
    this.scheduleFlush(immediate);
  }

  markDeleted(itemId) {
    this.dirty.delete(String(itemId));
    this.deleted.add(String(itemId));
    this.scheduleFlush(true);
  }

  scheduleFlush(immediate) {
    if (immediate) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.flushIntervalMs);
    }
  }

  // Writes the current in-memory state of every changed item. Writes are
  // whole-document upserts, so retrying after a failure is always safe.
  flush() {
    this.saving = this.saving.then(async () => {
      if (!this.dirty.size && !this.deleted.size && !this.eventBuffer.length && !this.interactionBuffer.length) return;
      const dirtyIds = [...this.dirty];
      const deletedIds = [...this.deleted];
      const events = this.eventBuffer.splice(0);
      const interactions = this.interactionBuffer.splice(0);
      this.dirty.clear();
      this.deleted.clear();
      try {
        const ops = dirtyIds
          .map((id) => this.items.get(id))
          .filter(Boolean)
          .map((item) => ({ replaceOne: { filter: { _id: item._id }, replacement: item, upsert: true } }));
        if (ops.length) await ItineraryItem.bulkWrite(ops, { ordered: true });
        if (deletedIds.length) await ItineraryItem.deleteMany({ _id: { $in: deletedIds } });
        if (events.length) {
          try {
            await TripEvent.insertMany(events, { ordered: false });
          } catch (err) {
            // Rows already saved by an earlier, half-finished attempt are fine.
            const errors = err.writeErrors ?? [];
            if (!(err.code === 11000 || (errors.length && errors.every((e) => (e.code ?? e.err?.code) === 11000)))) throw err;
          }
        }
        if (interactions.length) {
          await Interaction.insertMany(interactions, { ordered: false }).catch((err) =>
            // A lost taste signal only nudges recommendations; never block the board for it.
            log.error('interactions.save_failed', { tripId: this.tripId, error: err.message }),
          );
        }
        log.debug('board.flush', {
          tripId: this.tripId,
          correlationId: this.correlationId,
          saved: ops.length,
          deleted: deletedIds.length,
        });
      } catch (err) {
        // Put them back and retry shortly; the in-memory board is still correct.
        dirtyIds.forEach((id) => this.dirty.add(id));
        deletedIds.forEach((id) => this.deleted.add(id));
        this.eventBuffer.unshift(...events);
        log.error('board.flush_failed', { tripId: this.tripId, correlationId: this.correlationId, error: err.message });
        setTimeout(() => this.scheduleFlush(true), 1000).unref?.();
      }
    });
    return this.saving;
  }

  // Waits until everything changed so far is in the database.
  async drain() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
  }
}

// All live rooms in this process, keyed by tripId. A room is loaded from the
// database when its first traveller connects and unloaded (after saving) when
// the last one leaves.
export class RoomRegistry {
  constructor({ flushIntervalMs }) {
    this.flushIntervalMs = flushIntervalMs;
    this.rooms = new Map();
    this.loading = new Map();
    this.closing = new Map();
  }

  get(tripId) {
    return this.rooms.get(String(tripId));
  }

  async open(tripId) {
    const key = String(tripId);
    if (this.rooms.has(key)) return this.rooms.get(key);
    // If the room is still saving after its last traveller left, wait, or we
    // would load an out-of-date board from the database.
    if (this.closing.has(key)) await this.closing.get(key);
    if (this.rooms.has(key)) return this.rooms.get(key);
    // Two travellers connecting at the same moment share one load.
    if (!this.loading.has(key)) {
      this.loading.set(
        key,
        (async () => {
          try {
            const trip = await Trip.findById(key);
            if (!trip) return null;
            const [items, venues, destination, votes] = await Promise.all([
              ItineraryItem.find({ tripId: key }).lean(),
              venuesFor(trip.destination),
              findDestination(trip.destination),
              Vote.find({ tripId: key, status: 'open' }).lean(),
            ]);
            const room = new Room({
              trip,
              items,
              venues: new Map(venues.map((v) => [v._id, v.toPublic()])),
              names: new Map(),
              flushIntervalMs: this.flushIntervalMs,
              weather: destination?.weather ?? null,
              // Ids come back from MongoDB as ObjectIds; the room works with strings.
              votes: votes.map((v) => ({
                ...v,
                itemIds: v.itemIds.map(String),
                candidates: (v.candidates ?? []).map((c) => ({ ...c, itemId: String(c.itemId) })),
                openedByUserId: v.openedByUserId ? String(v.openedByUserId) : null,
                ballots: new Map(Object.entries(v.ballots ?? {})),
              })),
            });
            await room.loadNames();
            // The gateway decides what to do with restored votes and conflicts.
            this.onOpen?.(room);
            this.rooms.set(key, room);
            log.info('room.opened', { tripId: key, correlationId: room.correlationId, items: items.length });
            return room;
          } finally {
            this.loading.delete(key);
          }
        })(),
      );
    }
    return this.loading.get(key);
  }

  async close(tripId) {
    const room = this.rooms.get(String(tripId));
    if (!room || room.presence.size > 0 || room.pendingJoins > 0) return;
    this.rooms.delete(String(tripId));
    for (const timer of room.voteTimers.values()) clearTimeout(timer);
    room.voteTimers.clear();
    const done = room.drain().finally(() => this.closing.delete(String(tripId)));
    this.closing.set(String(tripId), done);
    await done;
    log.info('room.closed', { tripId: room.tripId, correlationId: room.correlationId });
  }

  async drainAll() {
    await Promise.all([...this.rooms.values()].map((r) => r.drain()));
  }
}
