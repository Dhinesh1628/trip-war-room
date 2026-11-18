import { z } from 'zod';
import { User } from '../auth/user.model.js';
import { atLeast } from '../auth/roles.js';
import { HttpError, forbidden, unauthorized, badRequest } from '../lib/errors.js';
import { formatIssues } from '../lib/validate.js';
import { log } from '../lib/logger.js';

// Thrown by board handlers when the state machine refuses a change.
export class BoardError extends HttpError {
  constructor({ code, message, current }) {
    super(409, code, message);
    this.current = current;
  }
}

function parse(schema, raw) {
  const result = schema.safeParse(raw);
  if (!result.success) throw badRequest('Event payload is invalid', formatIssues(result.error.issues));
  return result.data;
}

// Registers one client -> server event with the same checks for every event:
//   1. (sensitive only) token not expired, account role and trip re-read from the DB
//   2. caller is still a participant, with at least `min` role
//   3. (notMuted) caller is not muted; (frozen) leader is connected
//   4. payload passes its zod schema
// Then runs `fn` and answers through the Socket.io acknowledgement callback:
//   { ok: true, ...result }  or  { ok: false, error: { code, message, details? }, current? }
export function makeHandler({ socket, getRoom }) {
  return function on(event, options, fn) {
    const { schema = z.object({}).strict(), min = 'viewer', sensitive = false, notMuted = false, frozen = false, quiet = false } =
      options;

    socket.on(event, async (msg, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : typeof msg === 'function' ? msg : () => {};
      const started = performance.now();
      const room = getRoom();
      let user = socket.data.user;
      try {
        if (!room) throw new HttpError(409, 'ROOM_CLOSED', 'This room is no longer open; reconnect');

        if (sensitive) {
          if (!user.tokenExp || user.tokenExp * 1000 <= Date.now()) {
            throw unauthorized('Access token expired; send auth.renew with a fresh token', 'TOKEN_EXPIRED');
          }
          const [fresh] = await Promise.all([User.findById(user.id).select('role').lean(), room.reloadTrip()]);
          if (!fresh) throw unauthorized('Account no longer exists', 'INVALID_TOKEN');
          user = socket.data.user = { ...user, role: fresh.role };
        }

        const role = room.roleOf(user);
        if (!role) throw forbidden('You are no longer a participant in this trip');
        if (!atLeast(role, min)) throw forbidden(`This action needs the ${min} role or higher (you are ${role})`);
        if (notMuted && room.participants.get(user.id)?.muted) {
          throw new HttpError(403, 'MUTED', 'The trip leader has muted you');
        }
        if (frozen && !room.leaderConnected) {
          throw new HttpError(
            423,
            'LEADER_DISCONNECTED',
            'The trip leader is disconnected; lock and finalise actions are frozen until they return',
          );
        }

        const raw = msg && typeof msg === 'object' && 'payload' in msg ? msg.payload : msg;
        const payload = parse(schema, raw ?? {});
        const result = (await fn({ payload, room, user, role })) ?? {};
        ack({ ok: true, ...result });
        (quiet ? log.debug : log.info)(event, {
          tripId: room.tripId,
          correlationId: room.correlationId,
          userId: user.id,
          ms: Math.round(performance.now() - started),
        });
      } catch (err) {
        const known = err instanceof HttpError;
        if (!known) {
          log.error(`${event}.failed`, { tripId: room?.tripId, correlationId: room?.correlationId, error: err.message });
        } else {
          log.info(`${event}.rejected`, {
            tripId: room?.tripId,
            correlationId: room?.correlationId,
            userId: user?.id,
            code: err.code,
          });
        }
        ack({
          ok: false,
          error: known
            ? { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
            : { code: 'INTERNAL', message: 'Something went wrong' },
          ...(err.current ? { current: err.current } : {}),
        });
      }
    });
  };
}
