// Offline evaluation of the recommendation engine (spec 1.3: Precision@5 >= 0.6
// on your own held-out interaction set). No database needed.
// Usage: npm run eval:recs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDataset, PERSONAS } from '../src/recs/generate.js';
import { precisionAtK } from '../src/recs/evaluate.js';
import { ALPHA } from '../src/recs/recommender.js';

// The benchmark uses the Lisbon fixture so results stay comparable over time.
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/lisbon.json');
const venues = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).venues;
const SEEDS = [2026, 7, 42, 1234, 99];

console.log('Personas (venues each would like):');
for (const [key, p] of Object.entries(PERSONAS)) console.log(`  ${p.label.padEnd(20)} ${venues.filter(p.likes).length} of ${venues.length}`);

const scorers = ['popularity', 'content', 'collab', 'hybrid'];
const table = Object.fromEntries(scorers.map((s) => [s, []]));
let users = 0;
for (const seed of SEEDS) {
  const data = generateDataset(venues, { seed });
  for (const s of scorers) {
    const r = precisionAtK(venues, data, { scorer: s });
    table[s].push(r.precisionAt5);
    users = r.users;
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`\nPrecision@5 on held-out "next trip" likes (${SEEDS.length} seeds, ~${users} travellers each, alpha ${ALPHA}):`);
console.log(`  ${'method'.padEnd(12)} ${SEEDS.map((s) => String(s).padStart(6)).join(' ')}    mean`);
for (const s of scorers) {
  console.log(`  ${s.padEnd(12)} ${table[s].map((x) => x.toFixed(3).padStart(6)).join(' ')}   ${mean(table[s]).toFixed(3)}`);
}
const hybrid = mean(table.hybrid);
console.log(`\nHybrid mean Precision@5: ${hybrid.toFixed(3)} (target >= 0.6): ${hybrid >= 0.6 ? 'MET' : 'NOT MET'}`);
process.exitCode = hybrid >= 0.6 ? 0 : 1;
