import mongoose from 'mongoose';

// A traveller's review of a place: 1-5 stars and optional text. One per
// traveller per venue (writing again replaces it).
const reviewSchema = new mongoose.Schema(
  {
    venueId: { type: String, required: true },
    destination: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true },
);

reviewSchema.index({ venueId: 1, userId: 1 }, { unique: true });
reviewSchema.index({ destination: 1 });
reviewSchema.index({ userId: 1 });

export const Review = mongoose.model('Review', reviewSchema);
