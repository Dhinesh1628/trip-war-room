import mongoose from 'mongoose';
import { DIETARY_TAGS, VENUE_CATEGORIES } from './vocabulary.js';

// Venue / lodging / activity metadata (spec 7.2.1 venue_metadata).
// _id is the dataset's own venueId (e.g. "v_jai_001") so AI citations and
// itinerary items can reference a stable, human-readable id.
// Prices are in the destination's currency (INR for the Indian cities). For lodging, pricePerPerson is per person per night.
const venueSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    destination: { type: String, required: true }, // destination slug
    name: { type: String, required: true },
    category: { type: String, enum: VENUE_CATEGORIES, required: true },
    neighborhood: { type: String, required: true },
    pricePerPerson: { type: Number, required: true, min: 0 },
    dietaryTags: { type: [{ type: String, enum: DIETARY_TAGS }], default: [] },
    // "HH:MM". If close < open the venue is open past midnight (e.g. 22:00-03:00).
    hours: {
      open: { type: String, required: true },
      close: { type: String, required: true },
    },
    coordinates: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    rating: { type: Number, min: 0, max: 5, required: true },
    reviewCount: { type: Number, min: 0, required: true },
    indoor: { type: Boolean, required: true },
    description: { type: String, required: true },
    image: { type: {
      url: String,
      credit: String,
      license: String,
      source: String,
      representative: Boolean,
    }, default: undefined },
  },
  { timestamps: true },
);

// Spec 9.2: compound index for proximity queries within a destination.
venueSchema.index({ destination: 1, 'coordinates.lat': 1, 'coordinates.lng': 1 });
venueSchema.index({ destination: 1, category: 1 });

venueSchema.methods.toPublic = function toPublic() {
  return {
    venueId: this._id,
    name: this.name,
    category: this.category,
    neighborhood: this.neighborhood,
    pricePerPerson: this.pricePerPerson,
    dietaryTags: this.dietaryTags,
    hours: { open: this.hours.open, close: this.hours.close },
    coordinates: { lat: this.coordinates.lat, lng: this.coordinates.lng },
    rating: this.rating,
    reviewCount: this.reviewCount,
    indoor: this.indoor,
    description: this.description,
    image: this.image?.url ? { url: this.image.url, credit: this.image.credit, license: this.image.license, source: this.image.source, representative: Boolean(this.image.representative) } : null,
  };
};

export const Venue = mongoose.model('Venue', venueSchema);
