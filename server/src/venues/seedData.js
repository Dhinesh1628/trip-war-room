import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestDataset } from './ingest.js';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/destinations');

// Loads every *.json dataset in server/data/destinations. Safe to run again:
// each destination's venues are replaced, not duplicated.
export async function seedAllDestinations() {
  const files = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith('.json')).sort();
  const summaries = [];
  for (const file of files) {
    const json = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
    summaries.push({ file, ...(await ingestDataset(json)) });
  }
  return summaries;
}
