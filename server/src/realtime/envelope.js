// Every real-time message uses the same shape (spec 7.3.4):
// { event, tripId, payload, ts }
export function envelope(event, tripId, payload = {}) {
  return { event, tripId: tripId ?? null, payload, ts: Date.now() };
}
