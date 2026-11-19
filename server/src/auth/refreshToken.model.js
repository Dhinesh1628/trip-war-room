import mongoose from 'mongoose';

// Refresh tokens are random strings; only their SHA-256 hash is stored, so a
// database leak does not leak usable tokens. Each login starts a "family";
// every refresh replaces the token with a new one in the same family.
// Re-using an old (already replaced) token means it was probably stolen, so
// the whole family is revoked.
const refreshTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  family: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  // false = "don't keep me signed in": the cookie ends with the browser and the token lives a day.
  persistent: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// MongoDB deletes expired tokens by itself.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
