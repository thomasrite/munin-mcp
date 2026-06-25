// `local:init` core — one command that prepares a complete private local
// memory: a starter .env (fully-local posture), the at-rest blob encryption
// key, the PGlite data + blob directories (opening the store runs the
// engine's existing migrations unchanged), and the local tenant row. The
// tenant insert goes through the factory handle's raw Drizzle connection plus
// the engine schema subpath — the sanctioned control-plane pattern the demo
// seeder uses. PGlite-only by design: the hosted Postgres path keeps
// tenancy:seed + migrate.
//
// .env SAFETY (load-bearing): the repo-root .env is authoritative and loaded
// with override:true everywhere, so this module NEVER edits an existing .env.
// No .env → write the starter once (key + tenant id included). Existing .env →
// verify the local posture; proceed idempotently when complete, otherwise
// refuse with a line-by-line report and leave the file untouched. The
// encryption key is generated only when the starter is first written and is
// never regenerated — rotating it would orphan every encrypted blob.

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { tenants } from '@muninhq/engine/db/schema';
import { loadGraphStore } from '@muninhq/engine/graph-store';
import { isNull } from 'drizzle-orm';

export const DEFAULT_CONFIG_PACKAGE = '@muninhq/config-personal';
// The recommended local chat/extraction model. qwen2.5:7b is the model the F44
// measurement found extracts reliably (5/6 paragraphs); llama-family 7–8B models
// were unreliable (llama3.1:8b 0/6). The web setup
// screen's RECOMMENDED_OLLAMA_MODEL must track this value.
export const DEFAULT_OLLAMA_CHAT_MODEL = 'qwen2.5:7b';
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'bge-m3';
export const ENCRYPTION_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Secret env-file writer (shared by local:init and `munin init`)
// ---------------------------------------------------------------------------

/** Generate a fresh base64 AES-256 blob-encryption key. */
export function generateBlobEncryptionKey(): string {
  return randomBytes(ENCRYPTION_KEY_BYTES).toString('base64');
}

/**
 * Write an env file that CONTAINS THE AES BLOB KEY at mode 0600 — never
 * world/group readable. `wx` refuses to overwrite an existing file (these
 * commands never edit an existing env). The explicit chmod makes the mode exact
 * regardless of the process umask. Used by BOTH writer paths (local:init's
 * repo .env and `munin init`'s munin.env).
 *
 * REFUSES A SYMLINK TARGET (defence-in-depth, matching `set-key`'s
 * writeEnvFileSecure): `wx` rejects an existing regular file, but a pre-planted
 * symlink whose target does NOT yet exist would be FOLLOWED — `wx` would then
 * create (and write the secret into) the link's destination. lstat'ing the path
 * first and refusing a symlink closes that hole, so every secret-writing path
 * refuses symlinks uniformly.
 */
export function writeSecretEnvFile(envPath: string, content: string): void {
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(envPath);
  } catch {
    // ENOENT (or any stat failure) → no pre-existing entry to refuse; `wx`
    // below remains the authority on a racing creation.
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(`refusing to write a secret through a symlink: ${envPath}`);
  }
  fs.writeFileSync(envPath, content, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

// ---------------------------------------------------------------------------
// Pure: .env parsing
// ---------------------------------------------------------------------------

// Minimal KEY=VALUE parser with dotenv-compatible semantics for our purposes:
// comments and blanks skipped, last assignment wins, surrounding quotes
// stripped. Used only to ASSESS an existing .env — never to rewrite one.
export function parseEnvFile(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars.set(key, value);
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Pure: starter template
// ---------------------------------------------------------------------------

export interface StarterEnvOptions {
  readonly pgliteDataDir: string;
  readonly blobFsRoot: string;
  readonly encryptionKey: string;
  readonly tenantId: string;
}

export function renderStarterEnv(opts: StarterEnvOptions): string {
  return `# Munin — local memory. Written by \`pnpm --filter munin-mcp local:init\`.
# Posture: FULLY LOCAL — database, blobs, and AI models all stay on this
# machine; the engine refuses any provider that would send data off it.
# local:init never edits this file once it exists.

# --- Data store: PGlite (Postgres-in-WASM, in-process, single connection) ---
GRAPH_STORE=local
PGLITE_DATA_DIR=${opts.pgliteDataDir}

# --- Jobs: embedding + extraction run in-process (no worker daemon) ---------
JOBS=inline

# --- Zero-egress posture -----------------------------------------------------
MUNIN_LOCAL_MODE=true

# --- Per-read audit: OFF for local single-user -------------------------------
# The per-read access trail (MUNIN_READ_AUDIT) is a MANAGED/compliance control —
# one audit row written per read. A single local user does not need it ("their
# machine, their call"), and turning it off keeps the read path NON-WRITING: with
# it off the engine serves queries through the raw store with no AuditedGraphStore
# decorator, so the single-process PGlite store is never written during a read.
# That removes the everyday crash-corruption window — a process killed mid-read
# can no longer leave the on-disk database dirty. Set MUNIN_READ_AUDIT=true to
# re-enable the trail (e.g. a shared or audited setup).
MUNIN_READ_AUDIT=false

# --- AI: local Ollama daemon -------------------------------------------------
LLM_PROVIDER=ollama
EMBEDDING_PROVIDER=ollama
OLLAMA_MODEL=${DEFAULT_OLLAMA_CHAT_MODEL}
# The query pipeline passes ANSWER_MODEL to the provider — in local mode it
# must match OLLAMA_MODEL, or Ollama 404s on the cloud default.
ANSWER_MODEL=${DEFAULT_OLLAMA_CHAT_MODEL}
# bge-m3 embeds at 1024 dimensions, matching the engine schema.
OLLAMA_EMBEDDING_MODEL=bge-m3

# --- Blobs: encrypted files on disk (AES-256-GCM, mandatory in local mode) ---
BLOB_STORAGE_IMPL=filesystem
BLOB_STORAGE_FS_ROOT=${opts.blobFsRoot}
# At-rest key for the blobs above. Do NOT rotate or lose it — every stored
# document is encrypted with this key, and a new key orphans them all.
MUNIN_BLOB_ENCRYPTION_KEY=${opts.encryptionKey}

# --- Configuration (entity schemas, terminology, retrieval defaults) ---------
EXTRACTION_CONFIG_PACKAGE=${DEFAULT_CONFIG_PACKAGE}
MUNIN_CONFIG_PACKAGE=${DEFAULT_CONFIG_PACKAGE}

# --- Your local tenant (provisioned by local:init) ---------------------------
MUNIN_TENANT_ID=${opts.tenantId}

# --- Alternative: local store + your own cloud keys ---------------------------
# Your machine, your keys, your choice of provider: with cloud keys set, your
# document text and questions go to that provider under YOUR key and YOUR
# agreement with them. To switch, comment out MUNIN_LOCAL_MODE above, then
# uncomment and fill in (re-embed after switching embedding providers —
# vectors are not comparable across models):
# MUNIN_ALLOW_CLOUD_PROVIDERS=true
# LLM_PROVIDER=anthropic
# EMBEDDING_PROVIDER=openai
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# ANSWER_MODEL=claude-sonnet-4-6
`;
}

// ---------------------------------------------------------------------------
// Pure: existing-.env assessment
// ---------------------------------------------------------------------------

export interface EnvConflict {
  readonly key: string;
  readonly expected: string;
  readonly actual: string;
}

export interface EnvAssessment {
  readonly ok: boolean;
  // Expected lines absent from the file, formatted `KEY=value`.
  readonly missing: readonly string[];
  readonly conflicts: readonly EnvConflict[];
  // Preserved verbatim from the file when present.
  readonly encryptionKey?: string;
  readonly tenantId?: string;
  readonly configPackage?: string;
}

export interface AssessOptions {
  readonly pgliteDataDir: string;
  readonly blobFsRoot: string;
  // Relative paths in the .env resolve against this (the .env's directory).
  readonly baseDir: string;
  // Repo mode (default true) requires PGLITE_DATA_DIR/BLOB_STORAGE_FS_ROOT to
  // be present and exact. Home mode (`munin init`) derives the data dirs from
  // MUNIN_HOME, so it sets this false: their absence is expected, but if
  // present they must still match the derived layout (an explicit escape hatch).
  readonly requireDataPaths?: boolean;
}

export function assessExistingEnv(content: string, opts: AssessOptions): EnvAssessment {
  const vars = parseEnvFile(content);
  const missing: string[] = [];
  const conflicts: EnvConflict[] = [];

  const requireExact = (key: string, expected: string): void => {
    const actual = vars.get(key);
    if (actual === undefined) missing.push(`${key}=${expected}`);
    else if (actual.toLowerCase() !== expected) conflicts.push({ key, expected, actual });
  };
  requireExact('GRAPH_STORE', 'local');
  requireExact('JOBS', 'inline');
  requireExact('BLOB_STORAGE_IMPL', 'filesystem');

  // Posture: fully-local, or the explicitly acknowledged local-store +
  // cloud-AI alternative. Either declared posture passes; none → refuse.
  const localMode = vars.get('MUNIN_LOCAL_MODE')?.toLowerCase();
  const allowCloud = vars.get('MUNIN_ALLOW_CLOUD_PROVIDERS')?.toLowerCase();
  if (localMode !== 'true' && allowCloud !== 'true') {
    if (localMode === undefined) {
      missing.push('MUNIN_LOCAL_MODE=true (or MUNIN_ALLOW_CLOUD_PROVIDERS=true)');
    } else {
      conflicts.push({
        key: 'MUNIN_LOCAL_MODE',
        expected: 'true (or MUNIN_ALLOW_CLOUD_PROVIDERS=true)',
        actual: vars.get('MUNIN_LOCAL_MODE') ?? '',
      });
    }
  }

  const requireDataPaths = opts.requireDataPaths ?? true;
  const requirePath = (key: string, expected: string): void => {
    const actual = vars.get(key);
    if (actual === undefined) {
      // Home mode derives the data dirs from MUNIN_HOME — absence is expected.
      if (requireDataPaths) missing.push(`${key}=${expected}`);
    } else if (path.resolve(opts.baseDir, actual) !== path.resolve(expected)) {
      conflicts.push({ key, expected, actual });
    }
  };
  requirePath('PGLITE_DATA_DIR', opts.pgliteDataDir);
  requirePath('BLOB_STORAGE_FS_ROOT', opts.blobFsRoot);

  const requirePresent = (key: string, suggestion: string): string | undefined => {
    const actual = vars.get(key);
    if (actual === undefined || actual === '') {
      missing.push(`${key}=${suggestion}`);
      return undefined;
    }
    return actual;
  };
  requirePresent('LLM_PROVIDER', 'ollama');
  requirePresent('EMBEDDING_PROVIDER', 'ollama');
  const configPackage = requirePresent('EXTRACTION_CONFIG_PACKAGE', DEFAULT_CONFIG_PACKAGE);
  requirePresent('MUNIN_CONFIG_PACKAGE', DEFAULT_CONFIG_PACKAGE);
  const tenantId = requirePresent(
    'MUNIN_TENANT_ID',
    '<tenant uuid — or move this .env aside and re-run for a fresh starter>',
  );

  // The key is preserved byte-for-byte when present — but a key that cannot
  // decrypt/encrypt (wrong length) would fail later at the blob factory, so
  // surface it here as a conflict instead of proceeding.
  const encryptionKey = requirePresent(
    'MUNIN_BLOB_ENCRYPTION_KEY',
    '<generate with: openssl rand -base64 32>',
  );
  if (encryptionKey !== undefined) {
    const decoded = Buffer.from(encryptionKey, 'base64');
    if (decoded.length !== ENCRYPTION_KEY_BYTES) {
      conflicts.push({
        key: 'MUNIN_BLOB_ENCRYPTION_KEY',
        expected: `a base64 ${ENCRYPTION_KEY_BYTES}-byte key`,
        actual: `decodes to ${decoded.length} bytes`,
      });
    }
  }

  const ok = missing.length === 0 && conflicts.length === 0;
  return {
    ok,
    missing,
    conflicts,
    ...(encryptionKey !== undefined ? { encryptionKey } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(configPackage !== undefined ? { configPackage } : {}),
  };
}

// Diff-style refusal report for an existing .env that is not a complete local
// setup. The file is never edited — the user applies these lines by hand.
export function formatRefusalReport(envPath: string, assessment: EnvAssessment): string[] {
  const lines = [
    `.env already exists at ${envPath} — local:init never edits an existing .env.`,
    'It does not describe a complete local setup. Add or fix these lines by hand:',
  ];
  for (const m of assessment.missing) lines.push(`  + ${m}    (missing)`);
  for (const c of assessment.conflicts) {
    lines.push(`  ~ ${c.key}=${c.expected}    (currently: ${c.actual})`);
  }
  lines.push(
    'Then re-run local:init. (Or move the .env aside and re-run for a fresh starter file.)',
  );
  return lines;
}

export class LocalInitRefusalError extends Error {
  readonly reportLines: readonly string[];
  constructor(reportLines: readonly string[]) {
    super(reportLines.join('\n'));
    this.name = 'LocalInitRefusalError';
    this.reportLines = reportLines;
  }
}

// ---------------------------------------------------------------------------
// Tenant provisioning through the factory path
// ---------------------------------------------------------------------------

interface TenantRow {
  readonly id: string;
  readonly name: string;
}

// Minimal structural view of GraphStoreHandle.db: the postgres-js / PGlite
// Drizzle types don't unify into a callable union, but the chained query shape
// is identical. Same pattern as the demo seeder's control-plane inserts —
// tenant rows are control-plane data with no GraphStore reader/writer, and
// adding one would be an engine change this command must not make.
interface ControlPlaneDb {
  select(fields: { id: typeof tenants.id; name: typeof tenants.name }): {
    from(table: typeof tenants): { where(condition: unknown): Promise<TenantRow[]> };
  };
  insert(table: typeof tenants): {
    values(row: { id: string; name: string }): Promise<unknown>;
  };
}

interface EnsureTenantResult {
  readonly tenantId: string;
  readonly created: boolean;
}

// Open the store via the factory (GRAPH_STORE=local → PGlite; opening runs the
// existing migrations) and ensure exactly one live local tenant. Idempotent:
// an existing live tenant is reused, never duplicated.
export async function ensureLocalTenant(
  pgliteDataDir: string,
  requestedTenantId: string | undefined,
  baseEnv: NodeJS.ProcessEnv,
): Promise<EnsureTenantResult> {
  const handle = await loadGraphStore({
    ...baseEnv,
    GRAPH_STORE: 'local',
    PGLITE_DATA_DIR: pgliteDataDir,
  });
  try {
    const db = handle.db as unknown as ControlPlaneDb;
    const live = await db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(isNull(tenants.deletedAt));

    if (requestedTenantId !== undefined) {
      if (live.some((row) => row.id === requestedTenantId)) {
        return { tenantId: requestedTenantId, created: false };
      }
      if (live.length > 0) {
        throw new LocalInitRefusalError([
          `MUNIN_TENANT_ID in the .env is ${requestedTenantId}, but the local store at`,
          `${pgliteDataDir} holds different live tenant(s):`,
          ...live.map((row) => `  - ${row.id} (${row.name})`),
          'Fix MUNIN_TENANT_ID by hand (local:init never edits an existing .env).',
        ]);
      }
      // .env names a tenant but the store is empty (e.g. the data dir was
      // deleted) — re-materialise the row under the SAME id so the .env stays
      // untouched and still true.
      await db.insert(tenants).values({ id: requestedTenantId, name: 'local' });
      return { tenantId: requestedTenantId, created: true };
    }

    const first = live[0];
    if (live.length === 1 && first) {
      return { tenantId: first.id, created: false };
    }
    if (live.length > 1) {
      throw new LocalInitRefusalError([
        `The local store at ${pgliteDataDir} already holds ${live.length} live tenants:`,
        ...live.map((row) => `  - ${row.id} (${row.name})`),
        'local:init cannot choose between them. Set MUNIN_TENANT_ID in the .env yourself.',
      ]);
    }
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: 'local' });
    return { tenantId, created: true };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface LocalInitOptions {
  // Absolute data directory: PGlite at <directory>/pgdata, blobs at
  // <directory>/blobs.
  readonly directory: string;
  // Absolute path of the authoritative .env.
  readonly envPath: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
}

export interface LocalInitResult {
  readonly tenantId: string;
  readonly tenantCreated: boolean;
  readonly wroteEnv: boolean;
  readonly pgliteDataDir: string;
  readonly blobFsRoot: string;
  readonly configPackage: string;
}

export async function runLocalInit(opts: LocalInitOptions): Promise<LocalInitResult> {
  const log = opts.log ?? (() => {});
  const baseEnv = opts.baseEnv ?? process.env;
  const pgliteDataDir = path.join(opts.directory, 'pgdata');
  const blobFsRoot = path.join(opts.directory, 'blobs');
  fs.mkdirSync(pgliteDataDir, { recursive: true });
  fs.mkdirSync(blobFsRoot, { recursive: true });

  let existing: string | undefined;
  try {
    existing = fs.readFileSync(opts.envPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (existing !== undefined) {
    const assessment = assessExistingEnv(existing, {
      pgliteDataDir,
      blobFsRoot,
      baseDir: path.dirname(opts.envPath),
    });
    if (!assessment.ok) {
      throw new LocalInitRefusalError(formatRefusalReport(opts.envPath, assessment));
    }
    // Complete local .env → idempotent re-run. File untouched; key preserved
    // byte-for-byte by construction (we never write).
    const { tenantId, created } = await ensureLocalTenant(
      pgliteDataDir,
      assessment.tenantId,
      baseEnv,
    );
    log(`existing .env at ${opts.envPath} already describes this local setup — left untouched`);
    log(
      created
        ? `tenant ${tenantId} re-provisioned in the local store (row was absent)`
        : `tenant ${tenantId} already provisioned — reusing it`,
    );
    return {
      tenantId,
      tenantCreated: created,
      wroteEnv: false,
      pgliteDataDir,
      blobFsRoot,
      configPackage: assessment.configPackage ?? DEFAULT_CONFIG_PACKAGE,
    };
  }

  // Fresh setup: provision the tenant first (opening the store runs the
  // migrations), then write the complete starter exactly once at mode 0600
  // (the file holds the blob key). The shared writer's `wx` makes a concurrent
  // write of the same .env fail instead of overwriting.
  const encryptionKey = generateBlobEncryptionKey();
  const { tenantId, created } = await ensureLocalTenant(pgliteDataDir, undefined, baseEnv);
  const starter = renderStarterEnv({ pgliteDataDir, blobFsRoot, encryptionKey, tenantId });
  writeSecretEnvFile(opts.envPath, starter);
  log(`wrote ${opts.envPath} (fully-local posture; blob encryption key generated; mode 0600)`);
  log(
    created
      ? `tenant ${tenantId} provisioned in the local store at ${pgliteDataDir}`
      : `tenant ${tenantId} already existed in the local store — reused`,
  );
  return {
    tenantId,
    tenantCreated: created,
    wroteEnv: true,
    pgliteDataDir,
    blobFsRoot,
    configPackage: DEFAULT_CONFIG_PACKAGE,
  };
}

// ---------------------------------------------------------------------------
// Next steps (printed by the CLI)
// ---------------------------------------------------------------------------

export interface NextStepsOptions {
  readonly tenantId: string;
  readonly repoRoot: string;
  readonly configPackage: string;
}

export function buildNextSteps(opts: NextStepsOptions): string {
  return `
Next steps:

1. Pull the local models (one-time; needs Ollama — https://ollama.com):
     ollama pull ${DEFAULT_OLLAMA_EMBEDDING_MODEL}
     ollama pull ${DEFAULT_OLLAMA_CHAT_MODEL}
   Local extraction quality is model-dependent — small models miss
   relationships and mistype fields. Prefer a larger or cloud model before trusting extraction
   from a small local model.

2. Ingest a folder of documents:
     pnpm --filter munin-mcp ingest /path/to/your/docs --tenant ${opts.tenantId} --tags personal

3. Extract entities + relationships (runs in-process — JOBS=inline is set):
     pnpm --filter munin-mcp extract --tenant ${opts.tenantId}

4. Connect your AI client. The MCP server reads its config from a portable
   MUNIN_HOME, not this repo .env, so set one up and let connect write the
   client block for you:
     pnpm --filter munin-mcp munin init
     pnpm --filter munin-mcp munin mcp connect --client claude-desktop --write
     pnpm --filter munin-mcp munin mcp doctor
   (\`munin init\` creates ~/.munin with its own data + tenant; the repo .env
   above powers the CLI ingest/extract/query steps.)

Note: the local store is a single-process database. Stop the MCP server
before running ingest/extract, then start it again.
`;
}
