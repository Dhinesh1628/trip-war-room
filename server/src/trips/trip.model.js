import mongoose from 'mongoose';
import { TRIP_ROLES } from '../auth/roles.js';

export const TRIP_STATUSES = Object.freeze(['drafting', 'live', 'finalized']);
export const MAX_ROOM_CAPACITY = 50; // spec 1.3 design target

const participantSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: TRIP_ROLES, required: true },
    joinedAt: { type: Date, default: Date.now },
    muted: { type: Boolean, default: false }, // muted travellers cannot chat
  },
  { _id: false },
);

// Dates are stored as "YYYY-MM-DD" strings: a trip day is a calendar day at
// the destination, so storing a UTC timestamp would only invite timezone bugs.
const tripSchema = new mongoose.Schema(
  {
    leaderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    destination: { type: String, required: true }, // destination slug
    destinationName: { type: String, required: true },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    totalBudget: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    inviteCode: { type: String, required: true, unique: true },
    status: { type: String, enum: TRIP_STATUSES, default: 'drafting' },
    participants: { type: [participantSchema], default: [] },
    // People the leader removed; they cannot rejoin with the invite code.
    removedUserIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // A locked room accepts no new travellers.
    roomLocked: { type: Boolean, default: false },
    settings: {
      maxParticipants: { type: Number, min: 1, max: MAX_ROOM_CAPACITY, default: 8 },
      // Role given to people who join with the invite code.
      defaultJoinRole: { type: String, enum: ['planner', 'viewer'], default: 'planner' },
      aiVerbosity: { type: String, enum: ['concise', 'detailed'], default: 'concise' },
    },
  },
  { timestamps: true },
);

tripSchema.index({ 'participants.userId': 1, createdAt: -1 });

export const Trip = mongoose.model('Trip', tripSchema);
