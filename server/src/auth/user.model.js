import mongoose from 'mongoose';
import { ACCOUNT_ROLES } from './roles.js';
import { DIETARY_TAGS } from '../venues/vocabulary.js';

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ACCOUNT_ROLES, default: 'user' },
    preferences: {
      dietaryTags: { type: [{ type: String, enum: DIETARY_TAGS }], default: [] },
      // Max spend per person per item (in the trip's currency). Null = no personal ceiling.
      budgetCeiling: { type: Number, min: 0, default: null },
    },
    // Places this traveller saved with the heart button (venue ids, newest first).
    savedVenueIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

// The public shape of a user. Never includes the password hash.
userSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    email: this.email,
    displayName: this.displayName,
    role: this.role,
    preferences: {
      dietaryTags: this.preferences?.dietaryTags ?? [],
      budgetCeiling: this.preferences?.budgetCeiling ?? null,
    },
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
