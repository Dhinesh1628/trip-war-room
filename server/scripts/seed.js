// Loads the destination datasets in server/data/destinations into MongoDB.
// Usage: npm run seed   (reads MONGO_URI from server/.env)
import { loadConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { seedAllDestinations } from '../src/venues/seedData.js';

const config = loadConfig();
await connectDb(config.mongoUri);
try {
  for (const s of await seedAllDestinations()) {
    console.log(
      `${s.file}: ${s.destination} (${s.datasetVersion}) - ${s.venues} venues ` +
        `(${s.inserted} new, ${s.updated} updated, ${s.removed} removed), ` +
        `${s.transitLinks} transit links, ${s.weatherDays} forecast days`,
    );
  }
} catch (err) {
  console.error(err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
