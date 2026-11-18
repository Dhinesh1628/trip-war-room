import mongoose from 'mongoose';
import { z } from 'zod';
import { REACTIONS } from '../chat/chatMessage.model.js';
import { DIETARY_TAGS, VENUE_CATEGORIES } from '../venues/vocabulary.js';

// Payload rules for every client -> server WebSocket event.
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(TIME, 'Times must be HH:MM (00:00-23:59)');
const objectId = (label) =>
  z.string().refine((s) => mongoose.isValidObjectId(s), `${label} is not a valid id`);

const slot = {
  dayIndex: z.number().int('dayIndex must be a whole number').min(0, 'dayIndex cannot be negative'),
  startTime: time,
  endTime: time,
};
// A Concierge question (REST body and WebSocket payload). The optional fields
// override what is read from the question text.
export function concierge() {
  return z
    .object({
      question: z.string().min(1).max(2000),
      anchorItemId: objectId('anchorItemId').optional(),
      category: z.enum(VENUE_CATEGORIES).optional(),
      maxPricePerPerson: z.number().min(0).max(100000).optional(),
      dietaryTags: z.array(z.enum(DIETARY_TAGS)).max(DIETARY_TAGS.length).optional(),
      time: time.optional(),
      dayIndex: z.number().int().min(0).max(60).optional(),
      radiusKm: z.number().positive().max(50).optional(),
      // Accepted for compatibility with the spec's example body; the server
      // always uses the caller's own id from the token.
      userId: z.string().max(64).optional(),
    })
    .strict();
}

function sharingSplit() {
  return z
    .object({
      type: z.enum(['even', 'weighted']),
      weights: z.record(z.string(), z.number().int().min(0).max(100)).optional(),
    })
    .strict()
    .default({ type: 'even' });
}

const slotOrder = (s) => s.startTime < s.endTime;
const slotOrderMsg = { message: 'endTime must be after startTime (items cannot run past midnight)', path: ['endTime'] };

export const schemas = {
  pin: z
    .object({ venueId: z.string().min(1).max(60), ...slot })
    .strict()
    .refine(slotOrder, slotOrderMsg),
  move: z
    .object({ itemId: objectId('itemId'), ...slot, expectedVersion: z.number().int().min(1) })
    .strict()
    .refine(slotOrder, slotOrderMsg),
  remove: z.object({ itemId: objectId('itemId'), expectedVersion: z.number().int().min(1) }).strict(),
  lock: z.object({ itemId: objectId('itemId') }).strict(),

  chatSend: z
    .object({
      body: z.string().max(5000, 'Message is too long'),
      clientMsgId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  chatTyping: z.object({ isTyping: z.boolean() }).strict(),
  chatReact: z.object({ messageId: objectId('messageId'), emoji: z.enum(REACTIONS) }).strict(),
  chatHistory: z
    .object({ before: z.iso.datetime().optional(), limit: z.number().int().min(1).max(100).default(50) })
    .strict(),

  syncPing: z.object({ clientSentAt: z.number() }).strict(),
  syncReport: z.object({ rttMs: z.number().min(0).max(60000) }).strict(),
  authRenew: z.object({ token: z.string().min(10) }).strict(),

  voteOpen: z
    .object({
      itemIds: z.array(objectId('itemId')).min(2).max(6),
      durationSeconds: z.number().int().min(10).max(3600).optional(),
    })
    .strict(),
  voteCast: z.object({ voteId: objectId('voteId'), itemId: objectId('itemId') }).strict(),
  voteCancel: z.object({ voteId: objectId('voteId') }).strict(),

  aiAsk: concierge(),

  // Who attends an item and how its cost is shared.
  setSharing: z
    .object({
      itemId: objectId('itemId'),
      attendeeIds: z.array(objectId('attendee')).max(50).optional(), // [] or omitted = everyone
      split: sharingSplit(),
      expectedVersion: z.number().int().min(1),
    })
    .strict(),
  splitPropose: z
    .object({
      itemId: objectId('itemId'),
      attendeeIds: z.array(objectId('attendee')).max(50).optional(),
      split: sharingSplit(),
      durationSeconds: z.number().int().min(10).max(3600).optional(),
    })
    .strict(),
  splitCast: z.object({ voteId: objectId('voteId'), choice: z.enum(['yes', 'no']) }).strict(),

  mute: z.object({ userId: objectId('userId'), muted: z.boolean() }).strict(),
  removeParticipant: z.object({ userId: objectId('userId') }).strict(),
  lockRoom: z.object({ locked: z.boolean() }).strict(),
  transferLeader: z.object({ userId: objectId('userId') }).strict(),
};
