import { Destination } from './destination.model.js';
import { Venue } from './venue.model.js';
import { bus } from '../lib/bus.js';

// In-process cache of the venue catalog. Datasets only change through
// ingestDataset (seed or admin upload), which clears this cache, so reads
// never go stale. Saves one or two database round trips on every venue,
// Concierge and room-open request (about 60 ms each to a remote Atlas cluster).

export const DATASET_CHANGED = 'dataset.changed';

let destinations = null; // array of lean docs
const venuesBySlug = new Map(); // slug -> array of Venue documents

export function clearCatalog() {
  destinations = null;
  venuesBySlug.clear();
}
bus.on(DATASET_CHANGED, clearCatalog);

export async function allDestinations() {
  if (!destinations) destinations = await Destination.find().sort({ name: 1 }).lean();
  return destinations;
}

// Accepts a slug ("jaipur") or the display name ("Jaipur, India"), any case.
export async function findDestination(key) {
  const text = String(key).trim().toLowerCase();
  const list = await allDestinations();
  return list.find((d) => d.slug === text || d.name.toLowerCase() === text) ?? null;
}

export async function venuesFor(slug) {
  if (!venuesBySlug.has(slug)) venuesBySlug.set(slug, await Venue.find({ destination: slug }).sort({ _id: 1 }));
  return venuesBySlug.get(slug);
}
