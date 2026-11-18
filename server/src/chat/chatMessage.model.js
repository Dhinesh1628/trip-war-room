import mongoose from 'mongoose';

export const MESSAGE_TYPES = Object.freeze(['chat', 'ai_answer', 'system', 'conflict']);

// Fixed reaction set: the server only accepts these, so reactions cannot be
// used to store arbitrary text.
export const REACTIONS = Object.freeze(['👍', '❤️', '😂', '😮', '🎉', '👎']);

// Chat history plus system/AI/conflict notices (spec 7.2.1 chat_messages).
const chatMessageSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null for system/AI
    type: { type: String, enum: MESSAGE_TYPES, default: 'chat' },
    body: { type: String, required: true, maxlength: 4000 },
    // Lets a client safely resend after a reconnect without creating a duplicate.
    clientMsgId: { type: String, default: null },
    reactions: { type: Map, of: [String], default: {} }, // emoji -> userIds
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

chatMessageSchema.index({ tripId: 1, createdAt: -1 });
chatMessageSchema.index(
  { tripId: 1, userId: 1, clientMsgId: 1 },
  { unique: true, partialFilterExpression: { clientMsgId: { $type: 'string' } } },
);

export const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
