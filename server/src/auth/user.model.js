import mongoose from 'mongoose';
import { ACCOUNT_ROLES } from './roles.js';
import { DIETARY_TAGS } from '../venues/vocabulary.js';

const userSchema = new mongoose.Schema(
  {
    // Optional: phone-only accounts have none. Unique when present.
    email: { type: String, lowercase: true, trim: true },
    emailVerified: { type: Boolean, default: false },
    // E.164, e.g. +919876543210. Set when the traveller signs in with a code.
    phone: { type: String },
    // Google account id when the traveller signs in with Google.
    googleSub: { type: String },
    // False for accounts made with Google or a phone code until a password is set.
    passwordSet: { type: Boolean, default: true },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    passwordHash: { type: String, select: false },
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

// Unique only when the field is present (partial indexes).
for (const field of ['email', 'phone', 'googleSub']) {
  userSchema.index({ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $type: 'string' } } });
}

// The public shape of a user. Never includes the password hash.
userSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    email: this.email ?? null,
    emailVerified: Boolean(this.emailVerified),
    phone: this.phone ?? null,
    googleLinked: Boolean(this.googleSub),
    passwordSet: this.passwordSet !== false,
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
