import mongoose from 'mongoose';

// Single-use secrets, stored only as SHA-256 hashes:
//  - link tokens for password reset and email verification
//  - 6-digit phone sign-in codes (with an attempt counter)
// MongoDB deletes them after they expire.
const linkTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  purpose: { type: String, enum: ['reset', 'verify'], required: true },
  email: { type: String, default: null }, // the address being verified
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
linkTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const LinkToken = mongoose.model('LinkToken', linkTokenSchema);

const phoneCodeSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
phoneCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PhoneCode = mongoose.model('PhoneCode', phoneCodeSchema);
