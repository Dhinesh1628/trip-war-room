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
import { generateDataset, PRICE_SCALE } from '../src/recs/generate.js';
import { Interaction } from '../src/recs/interaction.model.js';

const config = loadConfig();
await connectDb(config.mongoUri);
try {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
  const rows = [];
  let travellers = 0;
  for (const [n, file] of files.entries()) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    const { venues } = data;
    const slug = data.destination.slug;
    const { train, test, users } = generateDataset(venues, { seed: 2026 + n, priceScale: PRICE_SCALE[data.destination.currency] ?? 1 });
    travellers = Math.max(travellers, users.length);
    // Synthetic travellers get stable ObjectIds derived from (a hash of) their
    // names, so the same traveller (persona + number) appears in every city.
    const idFor = new Map(
      users.map((u) => [u.userId, new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`synthetic:${u.userId}`).digest('hex').slice(0, 24))]),
    );
    if (new Set([...idFor.values()].map(String)).size !== users.length) throw new Error('synthetic id collision');
    // Both past trips and the "next trip" likes become history here.
    const history = [
      ...train,
      ...[...test].flatMap(([userId, ids]) =>
        [...ids].map((venueId) => ({ userId, venueId, liked: true, weight: 1, coTraveledWith: train.find((t) => t.userId === userId)?.coTraveledWith ?? [] })),
      ),
    ];
    for (const r of history) {
      rows.push({
        userId: idFor.get(r.userId),
        destination: slug,
        venueId: r.venueId,
        category: venues.find((v) => v.venueId === r.venueId).category,
        liked: r.liked,
        weight: r.weight,
        source: 'generated',
        coTraveledWith: r.coTraveledWith.map((c) => idFor.get(c)),
      });
    }
  }
  const removed = await Interaction.deleteMany({ source: 'generated' });
  await Interaction.insertMany(rows, { ordered: false });
  console.log(`Generated interactions: removed ${removed.deletedCount} old, inserted ${rows.length} for ${travellers} synthetic travellers across ${files.length} destinations.`);
} finally {
  await disconnectDb();
}
