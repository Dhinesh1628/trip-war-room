import { Trip } from './trip.model.js';
import { effectiveTripRole, atLeast } from '../auth/roles.js';
import { assertObjectId } from '../lib/validate.js';
import { forbidden, notFound } from '../lib/errors.js';

// Loads a trip and checks the caller's role in it. Returns { trip, role }.
// Throws 404 if the trip does not exist, 403 if the caller is not a
// participant or their role is below `minimum`. Reused by the WebSocket
// gateway in Phase 2 so both entry points enforce identical rules.
export async function loadTripWithRole(tripId, user, minimum = 'viewer') {
  assertObjectId(tripId, 'Trip');
  const trip = await Trip.findById(tripId);
  if (!trip) throw notFound('Trip not found');

  const role = effectiveTripRole(user, trip);
  if (!role) throw forbidden('You are not a participant in this trip');
  if (!atLeast(role, minimum)) {
    throw forbidden(`This action needs the ${minimum} role or higher (you are ${role})`);
  }
  return { trip, role };
}
