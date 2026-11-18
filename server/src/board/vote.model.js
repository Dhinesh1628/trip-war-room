import mongoose from 'mongoose';

// A contested-slot vote (spec 6.2). Kept in memory while the room is open and
// saved on every change, so an open vote survives a room unload or restart.
const voteSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    itemIds: { type: [mongoose.Schema.Types.ObjectId], required: true },
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
