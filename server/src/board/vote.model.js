import mongoose from 'mongoose';

// A contested-slot vote (spec 6.2). Kept in memory while the room is open and
// saved on every change, so an open vote survives a room unload or restart.
const voteSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    // 'slot': which of several items keeps a contested slot.
    // 'split': yes/no on a proposed change to who pays what for one item.
    kind: { type: String, enum: ['slot', 'split'], default: 'slot' },
    itemIds: { type: [mongoose.Schema.Types.ObjectId], required: true },
    proposal: { type: mongoose.Schema.Types.Mixed, default: null }, // split votes: { attendeeIds, split }
    expectedVersion: { type: Number, default: null }, // split votes: item version when proposed
    candidates: [{ _id: false, itemId: mongoose.Schema.Types.ObjectId, venueId: String, name: String }],
    openedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null = the system
    closesAt: { type: Date, required: true },
    ballots: { type: Map, of: String, default: {} }, // userId -> itemId
    status: { type: String, enum: ['open', 'resolved', 'cancelled'], default: 'open' },
    winnerItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    winningVenueId: { type: String, default: null },
    tally: { type: Map, of: Number, default: {} },
    resolvedAt: { type: Date, default: null },
    resolution: { type: String, default: null }, // 'votes' | 'tie_earliest_pin' | 'no_votes_earliest_pin'
  },
  { timestamps: true },
);

export const Vote = mongoose.model('Vote', voteSchema);
