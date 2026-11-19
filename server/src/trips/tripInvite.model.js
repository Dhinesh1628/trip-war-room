import mongoose from 'mongoose';

// An email invitation to a trip. The email carries the trip's invite link;
// this record lets the invited person see it on their dashboard.
const tripInviteSchema = new mongoose.Schema({
  tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});
tripInviteSchema.index({ tripId: 1, email: 1 }, { unique: true });

export const TripInvite = mongoose.model('TripInvite', tripInviteSchema);
