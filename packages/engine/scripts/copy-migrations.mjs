// Copy the SQL migrations (and the Drizzle `meta/` journal) into `dist` so the
// SAME `import.meta.url`-relative resolution used by `db/migrate.ts` and
// `graph/pglite-graph-store.ts` finds them from an INSTALLED package, with no
// engine source change. `tsc` emits only `.ts`→`.js`/`.d.ts`; the `.sql` files
// and the `meta/_journal.json` Drizzle reads are not source and must be copied.
//
// `src/db/migrations/*` -> `dist/db/migrations/*`. Run as the engine build's
// last step (`build` script) so `prepack`/`pnpm pack` always ships them.

import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const src = path.join(packageRoot, 'src', 'db', 'migrations');
const dest = path.join(packageRoot, 'dist', 'db', 'migrations');

if (!existsSync(src)) {
  console.error(`copy-migrations: source migrations folder not found at ${src}`);
  process.exit(1);
}
if (!existsSync(path.join(packageRoot, 'dist'))) {
  console.error('copy-migrations: dist/ not found — run `tsc` first (the build does this).');
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
// biome-ignore lint/suspicious/noConsole: intentional build-time progress output
console.log(
  `copy-migrations: ${path.relative(packageRoot, src)} -> ${path.relative(packageRoot, dest)}`,
);
