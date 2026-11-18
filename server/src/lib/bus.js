import { EventEmitter } from 'node:events';

// In-process event bus. The REST API announces trip changes here (someone
// joined, a role changed) and the real-time gateway listens, so the two
// modules stay decoupled. With several server processes this would become a
// shared pub/sub (e.g. Redis); see docs/DECISIONS.md.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const TRIP_CHANGED = 'trip.changed'; // payload: { tripId, reason }
