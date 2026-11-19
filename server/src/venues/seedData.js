import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestDataset } from './ingest.js';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/destinations');

// Loads every *.json dataset in server/data/destinations (the Indian cities).
// Safe to run again: each destination's venues are replaced, not duplicated.
// Tests pass an extra folder holding the Lisbon fixture.
export async function seedAllDestinations(dirs = [DATA_DIR]) {
  const summaries = [];
  for (const dir of dirs) {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const json = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      summaries.push({ file, ...(await ingestDataset(json)) });
    }
  }
  return summaries;
}
