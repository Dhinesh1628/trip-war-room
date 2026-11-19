// Loads the destination datasets in server/data/destinations into MongoDB.
// Usage: npm run seed                (reads MONGO_URI from server/.env)
//        npm run seed -- --prune     also removes destinations that are no
//                                    longer in the folder (and their venues)
import { loadConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { seedAllDestinations } from '../src/venues/seedData.js';
import { Destination } from '../src/venues/destination.model.js';
import { Venue } from '../src/venues/venue.model.js';

const prune = process.argv.includes('--prune');
const config = loadConfig();
await connectDb(config.mongoUri);
try {
  const summaries = await seedAllDestinations();
  for (const s of summaries) {
    console.log(
      `${s.file}: ${s.destination} (${s.datasetVersion}) - ${s.venues} venues ` +
        `(${s.inserted} new, ${s.updated} updated, ${s.removed} removed), ` +
        `${s.transitLinks} transit links, ${s.weatherDays} forecast days`,
    );
  }
  if (prune) {
    const keep = summaries.map((s) => s.destination);
    const old = await Destination.find({ slug: { $nin: keep } }).select('slug').lean();
    for (const { slug } of old) {
      const venues = await Venue.deleteMany({ destination: slug });
      await Destination.deleteOne({ slug });
      console.log(`removed destination ${slug} and its ${venues.deletedCount} venues`);
    }
    if (!old.length) console.log('nothing to prune');
  }
} catch (err) {
  console.error(err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
