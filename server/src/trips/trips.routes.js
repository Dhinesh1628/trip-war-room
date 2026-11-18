import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Trip, MAX_ROOM_CAPACITY } from './trip.model.js';
import { generateInviteCode, normalizeInviteCode } from './inviteCode.js';
import { loadTripWithRole } from './access.js';
import { User } from '../auth/user.model.js';
import { atLeast, effectiveTripRole } from '../auth/roles.js';
import { requireAuth } from '../auth/middleware.js';
import { findDestination } from '../venues/venues.routes.js';
import { validate, assertObjectId } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';

const MAX_TRIP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

const isoDate = z.iso.date({ error: 'Use the date format YYYY-MM-DD' });

const createTripSchema = z
  .object({
    destination: z.string().trim().min(1, 'destination is required').max(100),
    startDate: isoDate,
    endDate: isoDate,
    totalBudget: z
      .number({ error: 'totalBudget must be a number' })
      .positive('totalBudget must be positive')
      .max(1_000_000)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'totalBudget can have at most 2 decimals'),
    maxParticipants: z.number().int().min(1).max(MAX_ROOM_CAPACITY).default(8),
    defaultJoinRole: z.enum(['planner', 'viewer']).default('planner'),
  })
  .strict()
  .superRefine((t, ctx) => {
    const days = dayNumber(t.endDate) - dayNumber(t.startDate) + 1;
    if (days < 1) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate cannot be before startDate' });
    if (days > MAX_TRIP_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: `A trip can be at most ${MAX_TRIP_DAYS} days long` });
    }
  });

const joinSchema = z.object({ inviteCode: z.string().min(1, 'inviteCode is required').max(20) }).strict();

const roleChangeSchema = z.object({ role: z.enum(['planner', 'viewer']) }).strict();

const settingsSchema = z
  .object({
    maxParticipants: z.number().int().min(1).max(MAX_ROOM_CAPACITY).optional(),
    defaultJoinRole: z.enum(['planner', 'viewer']).optional(),
    aiVerbosity: z.enum(['concise', 'detailed']).optional(),
  })
  .strict()
  .refine((s) => Object.keys(s).length > 0, 'Send at least one setting to change');

// The JSON shape of a trip. Only Leaders/Admins see the invite code.
async function tripView(trip, user, config) {
  const ids = trip.participants.map((p) => p.userId);
  const users = await User.find({ _id: { $in: ids } }).select('displayName').lean();
  const names = Object.fromEntries(users.map((u) => [String(u._id), u.displayName]));
  const myRole = effectiveTripRole(user, trip);
  const canInvite = atLeast(myRole, 'leader');

  return {
    tripId: String(trip._id),
    destination: trip.destinationName,
    destinationSlug: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    dayCount: dayNumber(trip.endDate) - dayNumber(trip.startDate) + 1,
    totalBudget: trip.totalBudget,
    currency: trip.currency,
    status: trip.status,
    leaderUserId: String(trip.leaderUserId),
    myRole,
    ...(canInvite ? { inviteCode: trip.inviteCode, inviteUrl: inviteUrl(config, trip.inviteCode) } : {}),
    participants: trip.participants.map((p) => ({
      userId: String(p.userId),
      displayName: names[String(p.userId)] ?? 'Unknown traveller',
      role: p.role,
      joinedAt: p.joinedAt,
    })),
    participantCount: trip.participants.length,
    settings: {
      maxParticipants: trip.settings.maxParticipants,
      defaultJoinRole: trip.settings.defaultJoinRole,
      aiVerbosity: trip.settings.aiVerbosity,
    },
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
  };
}

const inviteUrl = (config, code) => `${config.clientOrigin}/join/${code}`;

// Saves a new doc, retrying with a fresh invite code on the (very rare) collision.
async function withUniqueInviteCode(fn) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fn(generateInviteCode());
    } catch (err) {
      if (err.code !== 11000 || !err.keyPattern?.inviteCode) throw err;
    }
  }
  throw new Error('Could not generate a unique invite code');
}

export function tripsRouter(config) {
  const router = express.Router();
  router.use(requireAuth(config));

  // Spec 7.3.1: POST /api/v1/trips. The creator becomes the trip's Leader.
  router.post('/', validate(createTripSchema), async (req, res) => {
    const body = req.valid.body;
    const destination = await findDestination(body.destination);
    if (!destination) {
      throw badRequest('Request is invalid', [
        { path: 'destination', message: `No venue dataset exists for "${body.destination}"` },
      ]);
    }
    const leaderId = new mongoose.Types.ObjectId(req.user.id);

    const trip = await withUniqueInviteCode((inviteCode) =>
      Trip.create({
        leaderUserId: leaderId,
        destination: destination.slug,
        destinationName: destination.name,
        startDate: body.startDate,
        endDate: body.endDate,
        totalBudget: body.totalBudget,
        inviteCode,
        participants: [{ userId: leaderId, role: 'leader' }],
        settings: { maxParticipants: body.maxParticipants, defaultJoinRole: body.defaultJoinRole },
      }),
    );

    res.status(201).json({
      tripId: String(trip._id),
      inviteCode: trip.inviteCode,
      inviteUrl: inviteUrl(config, trip.inviteCode),
      status: trip.status,
      leaderUserId: String(trip.leaderUserId),
      createdAt: trip.createdAt,
      trip: await tripView(trip, req.user, config),
    });
  });

  // Trips I lead or joined, newest first.
  router.get('/', async (req, res) => {
    const trips = await Trip.find({ 'participants.userId': req.user.id }).sort({ createdAt: -1 }).limit(100);
    res.json({ trips: await Promise.all(trips.map((t) => tripView(t, req.user, config))) });
  });

  // Preview before joining: enough to recognise the trip, nothing private.
  router.get('/invite/:code', async (req, res) => {
    const code = normalizeInviteCode(req.params.code);
    const trip = code && (await Trip.findOne({ inviteCode: code }));
    if (!trip) throw notFound('Invite code not found');
    const leader = await User.findById(trip.leaderUserId).select('displayName').lean();
    res.json({
      tripId: String(trip._id),
      destination: trip.destinationName,
      startDate: trip.startDate,
      endDate: trip.endDate,
      leaderName: leader?.displayName ?? 'Unknown',
      participantCount: trip.participants.length,
      maxParticipants: trip.settings.maxParticipants,
      joinRole: trip.settings.defaultJoinRole,
      alreadyJoined: trip.participants.some((p) => String(p.userId) === req.user.id),
    });
  });

  // Join with an invite code. Joining twice is harmless (returns the trip).
  router.post('/join', validate(joinSchema), async (req, res) => {
    const code = normalizeInviteCode(req.valid.body.inviteCode);
    if (!code) throw notFound('Invite code not found');
    const existing = await Trip.findOne({ inviteCode: code });
    if (!existing) throw notFound('Invite code not found');

    const userId = new mongoose.Types.ObjectId(req.user.id);
    if (existing.participants.some((p) => p.userId.equals(userId))) {
      return res.json({ joined: false, alreadyMember: true, trip: await tripView(existing, req.user, config) });
    }

    // Capacity check and insert in ONE atomic update, so two people taking
    // the last seat at the same moment cannot both get in.
    const trip = await Trip.findOneAndUpdate(
      {
        _id: existing._id,
        'participants.userId': { $ne: userId },
        $expr: { $lt: [{ $size: '$participants' }, '$settings.maxParticipants'] },
      },
      { $push: { participants: { userId, role: existing.settings.defaultJoinRole, joinedAt: new Date() } } },
      { returnDocument: 'after' },
    );
    if (!trip) {
      const fresh = await Trip.findById(existing._id);
      if (fresh.participants.some((p) => p.userId.equals(userId))) {
        return res.json({ joined: false, alreadyMember: true, trip: await tripView(fresh, req.user, config) });
      }
      throw conflict('ROOM_FULL', `This trip is full (${fresh.settings.maxParticipants} travellers max)`);
    }
    res.status(201).json({ joined: true, alreadyMember: false, trip: await tripView(trip, req.user, config) });
  });

  router.get('/:id', async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'viewer');
    res.json({ trip: await tripView(trip, req.user, config) });
  });

  // Leader only: change a participant between Planner and Viewer.
  router.patch('/:id/participants/:userId', validate(roleChangeSchema), async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'leader');
    assertObjectId(req.params.userId, 'Participant');
    const target = trip.participants.find((p) => String(p.userId) === req.params.userId);
    if (!target) throw notFound('Participant not found');
    if (target.role === 'leader') {
      throw forbidden("The leader's role cannot be changed here (leader transfer arrives with moderation controls)");
    }
    target.role = req.valid.body.role;
    await trip.save();
    res.json({ trip: await tripView(trip, req.user, config) });
  });

  // Leader only: room settings.
  router.patch('/:id/settings', validate(settingsSchema), async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'leader');
    const changes = req.valid.body;
    if (changes.maxParticipants !== undefined && changes.maxParticipants < trip.participants.length) {
      throw badRequest('Request is invalid', [
        {
          path: 'maxParticipants',
          message: `The trip already has ${trip.participants.length} travellers`,
        },
      ]);
    }
    Object.assign(trip.settings, changes);
    await trip.save();
    res.json({ trip: await tripView(trip, req.user, config) });
  });

  // Leader only: replace the invite code (the old one stops working).
  router.post('/:id/invite-code', async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'leader');
    const updated = await withUniqueInviteCode((inviteCode) =>
      Trip.findByIdAndUpdate(trip._id, { inviteCode }, { returnDocument: 'after', runValidators: true }),
    );
    res.json({ inviteCode: updated.inviteCode, inviteUrl: inviteUrl(config, updated.inviteCode) });
  });

  return router;
}
