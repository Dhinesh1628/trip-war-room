import mongoose from 'mongoose';

// The trip's event log: one row per board-changing or notable event, in
// order. Session analytics (spec 6.3) are computed from this log, so they
// can be reconciled with it exactly.
export const EVENT_TYPES = Object.freeze([
  'item_pinned',
  'item_moved',
  'item_removed',
  'item_locked',
  'item_unlocked',
  'sharing_changed',
  'vote_opened',
  'vote_cast',
  'vote_resolved',
  'vote_cancelled',
  'conflict_opened',
  'conflict_resolved',
  'ai_asked',
  'presence_joined',
  'presence_left',
  'chat_sent',
  'participant_removed',
]);

const tripEventSchema = new mongoose.Schema({
  tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true },
  seq: { type: Number, required: true }, // order within the trip (ms timestamp + counter)
  type: { type: String, enum: EVENT_TYPES, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  itemId: { type: mongoose.Schema.Types.ObjectId, default: null },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  ts: { type: Date, required: true },
});

// Unique, so a retried save can never write the same row twice.
tripEventSchema.index({ tripId: 1, seq: 1 }, { unique: true });

export const TripEvent = mongoose.model('TripEvent', tripEventSchema);
