// Vitest setup — loads the repo-root .env so tests that need provider keys
// can read them. Tests that don't need keys are unaffected.
//
// `override: true` is deliberate. Without it, any value already in the shell
// environment shadows the one in .env (dotenv's default `override: false`).
// That's a footgun for developers who edit .env and don't realise a stale
// export from .zshrc / .bashrc is still in scope. For local dev, the .env
// file is the authoritative source. Production / CI doesn't use dotenv at
// all — env vars come from the deployment system directly.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
config({ path: path.join(repoRoot, '.env'), override: true });
