import mongoose from 'mongoose';

export const LIFECYCLE_STAGES = Object.freeze(['drafting', 'voting', 'locked']);

// One card on the board (spec 7.2.1 itinerary_items).
// positionVersion goes up by one on every change; a move must quote the
// version it last saw, which is how concurrent moves are detected without
// database locks (spec 7.2 / 9.4).
// `venue` is a snapshot taken at pin time, so the board and the budget do not
// change if the dataset is re-uploaded later.
const itineraryItemSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true },
    venueId: { type: String, required: true },
    venue: {
      name: String,
      category: String,
      neighborhood: String,
      pricePerPerson: Number,
      coordinates: { lat: Number, lng: Number },
      hours: { open: String, close: String },
      dietaryTags: [String],
    },
    dayIndex: { type: Number, required: true, min: 0 },
    startTime: { type: String, required: true }, // "HH:MM"
    endTime: { type: String, required: true },
    lifecycleStage: { type: String, enum: LIFECYCLE_STAGES, default: 'drafting' },
    pinnedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    positionVersion: { type: Number, required: true, default: 1 },
    lockedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    votes: { type: mongoose.Schema.Types.Mixed, default: {} }, // used from Phase 3
  },
  { timestamps: true },
);

// Spec 9.2: fast board reads by (tripId, dayIndex).
itineraryItemSchema.index({ tripId: 1, dayIndex: 1 });

export const ItineraryItem = mongoose.model('ItineraryItem', itineraryItemSchema);
