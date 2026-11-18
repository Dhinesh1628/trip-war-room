import { ChatMessage, REACTIONS } from './chatMessage.model.js';

// The JSON shape of a message (trip.chat.message payload).
export function messageView(doc, names = new Map()) {
  const reactions = {};
  const raw = doc.reactions instanceof Map ? Object.fromEntries(doc.reactions) : doc.reactions || {};
  for (const emoji of REACTIONS) {
    const users = (raw[emoji] || []).map(String);
    if (users.length) reactions[emoji] = users;
  }
  const createdAt = new Date(doc.createdAt);
  return {
    messageId: String(doc._id),
    userId: doc.userId ? String(doc.userId) : null,
    displayName: doc.userId ? names.get(String(doc.userId)) ?? 'Traveller' : null,
    type: doc.type,
    body: doc.body,
    reactions,
    clientMsgId: doc.clientMsgId ?? null,
    meta: doc.meta ?? null,
    createdAt: createdAt.toISOString(),
    tsSeconds: Math.floor(createdAt.getTime() / 1000),
  };
}

// Saves a message. If the same client message id was already saved (a resend
// after reconnecting), returns the existing message instead of a duplicate.
export async function saveMessage({ tripId, userId = null, type = 'chat', body, clientMsgId = null, meta = null }) {
  try {
    const doc = await ChatMessage.create({ tripId, userId, type, body, clientMsgId, meta });
    return { doc, duplicate: false };
  } catch (err) {
    if (err.code === 11000 && clientMsgId) {
      const doc = await ChatMessage.findOne({ tripId, userId, clientMsgId });
      return { doc, duplicate: true };
    }
    throw err;
  }
}

// Newest `limit` messages before `before`, returned oldest first.
export async function history(tripId, { before, limit = 50 } = {}) {
  const filter = { tripId };
  if (before) filter.createdAt = { $lt: new Date(before) };
  const docs = await ChatMessage.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
  return docs.reverse();
}

// Adds the reaction if the user has not made it yet, otherwise removes it.
// Each branch is a single atomic update.
export async function toggleReaction({ tripId, messageId, userId, emoji }) {
  const path = `reactions.${emoji}`;
  const removed = await ChatMessage.findOneAndUpdate(
    { _id: messageId, tripId, [path]: userId },
    { $pull: { [path]: userId } },
    { returnDocument: 'after' },
  );
  if (removed) return removed;
  return ChatMessage.findOneAndUpdate(
    { _id: messageId, tripId },
    { $addToSet: { [path]: userId } },
    { returnDocument: 'after' },
  );
}
