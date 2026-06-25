// `pnpm --filter munin-mcp local:init [dir]` — one-command local bootstrap.
//
// Prepares a complete private local memory: generates the blob encryption
// key, writes a starter .env (fully-local posture), opens the PGlite store
// (which runs the engine migrations), provisions the local tenant through
// the factory path, and prints exact next steps.
//
// PGlite-only by design — for a hosted Postgres setup use `migrate` +
// `tenancy:seed` instead. Deliberately does NOT load dotenv: this command
// inspects and (only when absent) writes the .env itself.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalInitRefusalError, buildNextSteps, runLocalInit } from './local-init';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const HELP = `usage: local:init [dir]

Prepares a complete fully-local Munin memory in one command (PGlite only —
for hosted Postgres use \`migrate\` + \`tenancy:seed\`; there is no docker
path here). Writes the repo-root .env when absent; NEVER edits an existing
one — incomplete existing setups get a line-by-line report instead.

  dir   data directory (default: <repo>/.munin-local). PGlite data lands at
        <dir>/pgdata, encrypted blobs at <dir>/blobs. A relative dir resolves
        against the directory you invoked pnpm from.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const positional = argv.find((a) => !a.startsWith('-'));
  // pnpm --filter runs scripts with cwd at the package dir; INIT_CWD is where
  // the user actually invoked pnpm — resolve a relative [dir] against that.
  const invokeCwd = process.env.INIT_CWD?.trim() || process.cwd();
  const directory = positional
    ? path.resolve(invokeCwd, positional)
    : path.join(repoRoot, '.munin-local');

  const result = await runLocalInit({
    directory,
    envPath: path.join(repoRoot, '.env'),
    log: console.log,
  });
  console.log(
    buildNextSteps({
      tenantId: result.tenantId,
      repoRoot,
      configPackage: result.configPackage,
    }),
  );
}

main().catch((err) => {
  if (err instanceof LocalInitRefusalError) {
    console.error(err.reportLines.join('\n'));
  } else {
    console.error('local:init failed:', err);
  }
  process.exit(1);
});
