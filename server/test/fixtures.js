import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test-only data. The app ships Indian destinations; the automated suite also
// loads a fixed Lisbon dataset (USD) that most hand-checked tests are written
// against.
export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
