import mongoose from 'mongoose';
import { z } from 'zod';
import { REACTIONS } from '../chat/chatMessage.model.js';

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

  mute: z.object({ userId: objectId('userId'), muted: z.boolean() }).strict(),
  removeParticipant: z.object({ userId: objectId('userId') }).strict(),
  lockRoom: z.object({ locked: z.boolean() }).strict(),
  transferLeader: z.object({ userId: objectId('userId') }).strict(),
};
