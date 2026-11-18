// Runs the server against a throwaway in-memory MongoDB, so you can try the
// app without installing MongoDB or creating an Atlas cluster. The venue
// datasets are loaded automatically. All data is lost when the process stops.
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { main } from '../src/server.js';
import { seedAllDestinations } from '../src/venues/seedData.js';

const mongo = await MongoMemoryServer.create();
console.log('Using in-memory MongoDB (data is discarded on exit)');

// Optional: --port 5090 (to run next to the normal dev server).
// Optional: --bench lifts the sign-up/login rate limit so load tests can
// create many accounts. Never use it on a real deployment.
const portArg = process.argv.indexOf('--port');
const bench = process.argv.includes('--bench');
if (bench) console.log('BENCH MODE: auth rate limit lifted for load testing');
await main({
  ...process.env,
  ...(bench ? { AUTH_RATE_LIMIT: '1000000', CONCIERGE_RATE_LIMIT: '1000000', INVITE_RATE_LIMIT: '1000000' } : {}),
  ...(portArg > 0 ? { PORT: process.argv[portArg + 1], CLIENT_ORIGIN: process.env.CLIENT_ORIGIN } : {}),
  MONGO_URI: mongo.getUri('trip-war-room'),
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex'),
});

const seeded = await seedAllDestinations();
console.log(`Seeded ${seeded.map((s) => `${s.destination} (${s.venues} venues)`).join(', ')}`);
