// Idempotent in-place migration: turn the per-read audit trail OFF for an
// EXISTING local home that predates the read-audit-off posture.
//
// WHY. The fully-local store is single-process PGlite. A process killed
// mid-WRITE leaves the on-disk pgdata dirty/corrupt (recoverable only by a
// rebuild). The everyday write on the local READ path is the per-read audit row:
// the engine wraps the store in AuditedGraphStore whenever readAuditEnabled(env)
// is true, and older local homes never set MUNIN_READ_AUDIT, so it defaulted ON
// — every retrieve/ask wrote to the store via a background flush. The per-read
// trail is a managed/compliance control, not needed for a single local user; off
// it, the read path is non-writing and the everyday crash-corruption window
// closes. Fresh homes get MUNIN_READ_AUDIT=false from the starter writers
// (home-init / local-init); this migration back-fills the homes written before
// that change.
//
// SCOPE + SAFETY. Gated on GRAPH_STORE=local (only the single-process store has
// this risk; the hosted Postgres path never reads munin.env). It NEVER overrides
// an explicit value the user set — true OR false — so a user who deliberately
// re-enabled the trail keeps it. The file write is crash-safe (temp + atomic
// rename) and re-pins mode 0600 (munin.env holds the AES blob key and may hold a
// cloud API key); it refuses to write through a symlink. The pure
// migrateLocalReadAuditOff is also reused by `munin set-key`, which folds it into
// the content it already rewrites.

import fs from 'node:fs';
import path from 'node:path';

import { parseEnvFile } from './local-init';

export const READ_AUDIT_KEY = 'MUNIN_READ_AUDIT';

// The labelled block appended when back-filling. Distinct wording from the
// starter writers' comment so it is obvious in a diff that this line was added by
// the migration, not hand-written.
const MIGRATION_BLOCK = [
  '',
  '# --- Per-read audit: OFF for local single-user (added automatically) ---------',
  '# Back-filled by `munin setup` / `munin mcp doctor` so the local read path is',
  '# non-writing: the per-read audit trail is a managed/compliance control, and',
  '# writing on every read kept the single-process store in a path a crash could',
  '# corrupt. Set MUNIN_READ_AUDIT=true to re-enable it.',
  `${READ_AUDIT_KEY}=false`,
].join('\n');

export interface ReadAuditMigrationResult {
  readonly changed: boolean;
  readonly content: string;
}

/**
 * Pure: given munin.env content, return content with MUNIN_READ_AUDIT=false
 * appended IFF the file declares the local single-process store
 * (GRAPH_STORE=local) and has NO existing MUNIN_READ_AUDIT assignment. A
 * non-local file, or one that already assigns the key (to any value), is
 * returned unchanged — the migration never overrides an explicit choice.
 */
export function migrateLocalReadAuditOff(content: string): ReadAuditMigrationResult {
  const vars = parseEnvFile(content);
  if (vars.get('GRAPH_STORE')?.toLowerCase() !== 'local') return { changed: false, content };
  if (vars.has(READ_AUDIT_KEY)) return { changed: false, content };
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  return { changed: true, content: `${content}${needsNewline ? '\n' : ''}${MIGRATION_BLOCK}\n` };
}

/**
 * Crash-safe in-place rewrite of a secret env file: refuse a symlink target,
 * write a sibling temp at mode 0600, then atomically rename over the original.
 * No backup — the rename is atomic, so a crash leaves either the old file or the
 * new one, never a partial. (set-key keeps its own backup-on-write because that
 * is a deliberate, user-invoked posture change; this migration is automatic and
 * additive, so a backup would just clutter the home.)
 */
function secureRewriteEnvFile(envPath: string, content: string): void {
  const lstat = fs.lstatSync(envPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink: ${envPath}`);
  }
  const dir = path.dirname(envPath);
  const tmp = path.join(dir, `.munin-read-audit-migration-${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, envPath);
}

export interface ApplyMigrationOptions {
  readonly log?: (line: string) => void;
}

/**
 * Apply migrateLocalReadAuditOff to the munin.env at `envPath`, in place. A
 * missing file is a no-op (the command that called us reports the missing home
 * separately). Returns true when the line was added. Idempotent: once the line
 * exists, every later call is a no-op and writes nothing.
 */
export function applyLocalReadAuditMigration(
  envPath: string,
  opts: ApplyMigrationOptions = {},
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const migrated = migrateLocalReadAuditOff(content);
  if (!migrated.changed) return false;
  secureRewriteEnvFile(envPath, migrated.content);
  opts.log?.(
    `note: set ${READ_AUDIT_KEY}=false in ${envPath} (local single-user posture — keeps the read path non-writing so a crash can't corrupt the store; set it true to re-enable the audit trail)`,
  );
  return true;
}
