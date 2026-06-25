// Vitest setup — loads the repo-root .env so tests that need provider keys
// can read them. Tests that don't need keys are unaffected.
//
// `override: true` is deliberate (see the engine's test-setup for the full
// rationale): for local dev the repo-root .env is the authoritative source and
// must win over any stale shell export. Production / CI does not use dotenv.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
config({ path: path.join(repoRoot, '.env'), override: true });
