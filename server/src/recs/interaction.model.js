import mongoose from 'mongoose';

// Taste signals that train the recommendation engine (spec 7.2.1
// interactions). Recorded automatically as people plan (pin, vote, remove)
// plus explicit likes and dislikes.
export const INTERACTION_SOURCES = Object.freeze(['pin', 'vote', 'remove', 'feedback', 'generated']);

const interactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },
  destination: { type: String, required: true },
  venueId: { type: String, required: true },
  category: { type: String, required: true },
  liked: { type: Boolean, required: true },
  weight: { type: Number, default: 1 }, // strength of the signal
  source: { type: String, enum: INTERACTION_SOURCES, required: true },
  // Group affinity: who this person was planning with (spec 6.3).
  coTraveledWith: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  createdAt: { type: Date, default: Date.now },
});

interactionSchema.index({ destination: 1, venueId: 1 });

export const Interaction = mongoose.model('Interaction', interactionSchema);
