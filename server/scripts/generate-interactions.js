// Loads the generated interaction dataset into MongoDB so live
// recommendations have history to learn from (spec 6.3). Safe to re-run:
// earlier generated rows are replaced; real planning signals are kept.
// Usage: npm run generate:interactions
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { loadConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { DATA_DIR } from '../src/venues/seedData.js';
import { generateDataset } from '../src/recs/generate.js';
import { Interaction } from '../src/recs/interaction.model.js';

const config = loadConfig();
await connectDb(config.mongoUri);
try {
  const venues = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'lisbon.json'), 'utf8')).venues;
  const { train, test, users } = generateDataset(venues, { seed: 2026 });
  // Synthetic travellers get stable ObjectIds derived from (a hash of) their names.
  const idFor = new Map(
    users.map((u) => [u.userId, new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`synthetic:${u.userId}`).digest('hex').slice(0, 24))]),
  );
  if (new Set([...idFor.values()].map(String)).size !== users.length) throw new Error('synthetic id collision');
  // Both past trips and the "next trip" likes become history here.
  const rows = [
    ...train,
    ...[...test].flatMap(([userId, ids]) =>
      [...ids].map((venueId) => ({ userId, venueId, liked: true, weight: 1, coTraveledWith: train.find((t) => t.userId === userId)?.coTraveledWith ?? [] })),
    ),
  ].map((r) => ({
    userId: idFor.get(r.userId),
    destination: 'lisbon',
    venueId: r.venueId,
    category: venues.find((v) => v.venueId === r.venueId).category,
    liked: r.liked,
    weight: r.weight,
    source: 'generated',
    coTraveledWith: r.coTraveledWith.map((c) => idFor.get(c)),
  }));
  const removed = await Interaction.deleteMany({ source: 'generated' });
  await Interaction.insertMany(rows, { ordered: false });
  console.log(`Generated interactions: removed ${removed.deletedCount} old, inserted ${rows.length} for ${users.length} synthetic travellers.`);
} finally {
  await disconnectDb();
}
