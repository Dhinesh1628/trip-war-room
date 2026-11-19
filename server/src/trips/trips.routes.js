import { TripInvite } from './tripInvite.model.js';
import { sendEmail, channels, NotConfiguredError } from '../notify/notify.js';
import { DEFAULT_CURRENCY } from '../lib/money.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
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
import { badRequest, conflict, forbidden, notFound, HttpError } from '../lib/errors.js';
import { bus, TRIP_CHANGED } from '../lib/bus.js';
import { concierge } from '../board/schemas.js';
import { ItineraryItem } from '../board/itineraryItem.model.js';
import { TripEvent } from '../board/tripEvent.model.js';
import { computeBudget } from '../board/budgetEngine.js';
import { computeAnalytics, reconcile } from '../analytics/sessionAnalytics.js';
import { recommendForTrip } from '../recs/service.js';

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
      .max(100_000_000) // ₹10 crore: plenty for a group trip in rupees
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
      muted: Boolean(p.muted),
    })),
    participantCount: trip.participants.length,
    roomLocked: Boolean(trip.roomLocked),
    settings: {
      maxParticipants: trip.settings.maxParticipants,
      defaultJoinRole: trip.settings.defaultJoinRole,
      aiVerbosity: trip.settings.aiVerbosity,
    },
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
  };
}

// A trip's money is in its destination's currency (INR for the Indian cities).
const currencyOf = async (trip) => (await findDestination(trip.destination))?.currency ?? DEFAULT_CURRENCY;

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

export function tripsRouter(config, { gateway } = {}) {
  const router = express.Router();
  router.use(requireAuth(config));

  // Invite codes must not be guessable by brute force: previews and joins are
  // limited per account (31^6 codes, 30 tries per 15 minutes).
  const inviteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.inviteRateLimit,
    keyGenerator: (req) => `user:${req.user.id}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many invite attempts. Try again in a few minutes.' } },
  });

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
        currency: destination.currency,
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
  router.get('/invite/:code', inviteLimiter, async (req, res) => {
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
  router.post('/join', inviteLimiter, validate(joinSchema), async (req, res) => {
    const code = normalizeInviteCode(req.valid.body.inviteCode);
    if (!code) throw notFound('Invite code not found');
    const existing = await Trip.findOne({ inviteCode: code });
    if (!existing) throw notFound('Invite code not found');

    const userId = new mongoose.Types.ObjectId(req.user.id);
    if (existing.participants.some((p) => p.userId.equals(userId))) {
      return res.json({ joined: false, alreadyMember: true, trip: await tripView(existing, req.user, config) });
    }
    if (existing.removedUserIds.some((id) => id.equals(userId))) {
      throw forbidden('The trip leader removed you from this trip');
    }
    if (existing.roomLocked) throw new HttpError(403, 'ROOM_LOCKED', 'The trip leader has locked this room');

    // Capacity check and insert in ONE atomic update, so two people taking
    // the last seat at the same moment cannot both get in.
    const trip = await Trip.findOneAndUpdate(
      {
        _id: existing._id,
        'participants.userId': { $ne: userId },
        removedUserIds: { $ne: userId },
        roomLocked: { $ne: true },
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
      if (fresh.roomLocked) throw new HttpError(403, 'ROOM_LOCKED', 'The trip leader has locked this room');
      if (fresh.removedUserIds.some((id) => id.equals(userId))) {
        throw forbidden('The trip leader removed you from this trip');
      }
      throw conflict('ROOM_FULL', `This trip is full (${fresh.settings.maxParticipants} travellers max)`);
    }
    bus.emit(TRIP_CHANGED, { tripId: String(trip._id), reason: 'joined' });
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
    bus.emit(TRIP_CHANGED, { tripId: String(trip._id), reason: 'role' });
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
    bus.emit(TRIP_CHANGED, { tripId: String(trip._id), reason: 'settings' });
    res.json({ trip: await tripView(trip, req.user, config) });
  });

  // Spec 7.3.3: ask the AI Concierge. Viewer+ (any participant). The answer is
  // also broadcast to the room (trip.ai.suggestion) and saved in the chat.
  router.post('/:id/ai/ask', validate(concierge()), async (req, res) => {
    if (!gateway) throw new HttpError(503, 'UNAVAILABLE', 'The Concierge is not running');
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'viewer');
    const room = await gateway.registry.open(String(trip._id));
    room.pendingJoins += 1; // keep the room open for the duration of the question
    try {
      const result = await gateway.ask(room, req.user, req.valid.body);
      res.json(result);
    } finally {
      room.pendingJoins -= 1;
      gateway.registry.close(room.tripId); // only closes if nobody is connected
    }
  });

  // Saves an open room's pending changes, so reads below see everything.
  async function settle(tripId) {
    const room = gateway?.registry.get(String(tripId));
    if (room) await room.drain();
  }

  async function namesFor(ids) {
    const users = await User.find({ _id: { $in: ids } }).select('displayName').lean();
    return new Map(users.map((u) => [String(u._id), u.displayName]));
  }

  // The full budget breakdown: per item who pays what, running totals, per person.
  router.get('/:id/budget', async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'viewer');
    await settle(trip._id);
    const participantIds = trip.participants.map((p) => String(p.userId));
    const [items, users] = await Promise.all([
      ItineraryItem.find({ tripId: trip._id }).lean(),
      User.find({ _id: { $in: participantIds } }).select('displayName preferences.budgetCeiling').lean(),
    ]);
    items.sort((a, b) => a.dayIndex - b.dayIndex || a.startTime.localeCompare(b.startTime) || String(a._id).localeCompare(String(b._id)));
    const budget = computeBudget({
      items,
      participantIds,
      totalBudget: trip.totalBudget,
      ceilings: new Map(users.map((u) => [String(u._id), u.preferences?.budgetCeiling ?? null])),
      currency: await currencyOf(trip),
    });
    const names = new Map(users.map((u) => [String(u._id), u.displayName]));
    res.json({
      currency: budget.currency,
      totalBudget: budget.totalBudget,
      groupTotal: budget.groupCommitted,
      remaining: budget.remaining,
      overBudget: budget.overBudget,
      perPerson: budget.perPerson.map((p) => ({ ...p, displayName: names.get(p.userId) ?? null })),
      items: budget.lines.map((l) => ({
        itemId: l.itemId,
        name: l.name,
        dayIndex: l.dayIndex,
        startTime: l.startTime,
        split: l.split,
        attendees: l.attendees,
        total: l.totalCents / 100,
        shares: Object.fromEntries(Object.entries(l.shares).map(([k, v]) => [k, v / 100])),
        runningTotals: Object.fromEntries(Object.entries(l.runningCents).map(([k, v]) => [k, v / 100])),
      })),
    });
  });

  // Session analytics (spec 6.3), computed from the trip's event log, plus a
  // check that the log replays to exactly the stored board.
  router.get('/:id/analytics', async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'viewer');
    await settle(trip._id);
    const participantIds = trip.participants.map((p) => String(p.userId));
    const [events, items, names] = await Promise.all([
      TripEvent.find({ tripId: trip._id }).sort({ seq: 1 }).lean(),
      ItineraryItem.find({ tripId: trip._id }).lean(),
      namesFor(participantIds),
    ]);
    const { _finalItems, ...analytics } = computeAnalytics(events, { participantIds, totalBudget: trip.totalBudget, names, currency: await currencyOf(trip) });
    res.json({ tripId: String(trip._id), destination: trip.destinationName, ...analytics, reconciliation: reconcile(_finalItems, items) });
  });

  // "Recommended for your group" (spec 6.3).
  router.get('/:id/recommendations', async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'viewer');
    await settle(trip._id);
    const memberIds = trip.participants.map((p) => String(p.userId));
    const [items, members] = await Promise.all([
      ItineraryItem.find({ tripId: trip._id }).select('venueId').lean(),
      User.find({ _id: { $in: memberIds } }).select('preferences.dietaryTags').lean(),
    ]);
    const dietaryTags = [...new Set(members.flatMap((m) => m.preferences?.dietaryTags ?? []))].sort();
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    const result = await recommendForTrip({
      destination: trip.destination,
      memberIds,
      excludeVenueIds: items.map((i) => i.venueId),
      dietaryTags,
      limit,
    });
    res.json({ tripId: String(trip._id), destination: trip.destinationName, groupDietaryTags: dietaryTags, ...result });
  });

  // Leader only: email someone the invite link. At most 30 per trip per day.
  const inviteEmailSchema = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254) }).strict();
  router.post('/:id/invites', validate(inviteEmailSchema), async (req, res) => {
    const { trip } = await loadTripWithRole(req.params.id, req.user, 'leader');
    if (!channels(config).email) throw new HttpError(503, 'EMAIL_UNAVAILABLE', 'Email invites are not set up on this server yet');
    const to = req.valid.body.email;
    const today = await TripInvite.countDocuments({ tripId: trip._id, createdAt: { $gt: new Date(Date.now() - 86400_000) } });
    if (today >= 30) throw new HttpError(429, 'RATE_LIMITED', 'You have sent 30 invites for this trip today. Try again tomorrow, or share the link.');
    const member = await User.findOne({ email: to }).select('_id').lean();
    if (member && trip.participants.some((p) => String(p.userId) === String(member._id))) {
      throw conflict('ALREADY_MEMBER', `${to} is already in this trip`);
    }
    await TripInvite.updateOne({ tripId: trip._id, email: to }, { $set: { invitedBy: req.user.id, createdAt: new Date() } }, { upsert: true });
    const url = inviteUrl(config, trip.inviteCode);
    const from = req.user.name ?? 'A friend';
    try {
      await sendEmail(config, {
        to,
        subject: `${from} invited you to plan a trip to ${trip.destinationName}`,
        text: `${from} invited you to plan ${trip.destinationName} (${trip.startDate} to ${trip.endDate}) together on Trip War Room.

Join the trip: ${url}

Invite code: ${trip.inviteCode}`,
        html: `<p>${escapeHtml(from)} invited you to plan <b>${escapeHtml(trip.destinationName)}</b> (${trip.startDate} to ${trip.endDate}) together on Trip War Room.</p><p><a href="${url}">Join the trip</a></p><p>Invite code: ${trip.inviteCode}</p>`,
      });
    } catch (err) {
      if (err instanceof NotConfiguredError) throw new HttpError(503, 'EMAIL_UNAVAILABLE', err.message);
      throw new HttpError(502, 'EMAIL_FAILED', "We couldn't send the invite. Try again, or share the link.");
    }
    res.status(202).json({ sent: true, email: to });
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
