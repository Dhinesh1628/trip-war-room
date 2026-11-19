import { Destination } from './destination.model.js';
import { Venue } from './venue.model.js';
import { validateDataset } from './datasetSchema.js';
import { badRequest } from '../lib/errors.js';
import { bus } from '../lib/bus.js';
import { DATASET_CHANGED } from './catalog.js';

// Validates a destination dataset and loads it, replacing that destination's
// previous venues. Used by the seed script and (Phase 4) the admin upload.
// Returns a short summary of what changed.
export async function ingestDataset(input) {
  const result = validateDataset(input);
  if (!result.ok) throw badRequest('Dataset is invalid', result.errors);
  const { destination, venues, transit, weather, walking, datasetVersion } = result.data;

  const ids = venues.map((v) => v.venueId);
  const clash = await Venue.findOne({ _id: { $in: ids }, destination: { $ne: destination.slug } }).lean();
  if (clash) {
    throw badRequest('Dataset is invalid', [
      { path: 'venues', message: `venueId ${clash._id} already belongs to destination "${clash.destination}"` },
    ]);
  }

  await Destination.findOneAndUpdate(
    { slug: destination.slug },
    { ...destination, transit, weather, walking: walking ?? null, datasetVersion },
    { upsert: true, runValidators: true },
  );

  const ops = venues.map(({ venueId, ...rest }) => ({
    replaceOne: {
      filter: { _id: venueId },
      replacement: { _id: venueId, destination: destination.slug, ...rest },
      upsert: true,
    },
  }));
  const write = await Venue.bulkWrite(ops, { ordered: true });
  const removed = await Venue.deleteMany({ destination: destination.slug, _id: { $nin: ids } });
  // Cached catalogs and open rooms reload the new data.
  bus.emit(DATASET_CHANGED, { destination: destination.slug });

  return {
    destination: destination.slug,
    datasetVersion,
    venues: venues.length,
    inserted: write.upsertedCount,
    updated: write.modifiedCount,
    removed: removed.deletedCount,
    transitLinks: transit.length,
    weatherDays: weather.daily.length,
  };
}
