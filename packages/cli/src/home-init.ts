// `munin init` core — bootstrap a portable per-user MUNIN_HOME (F68 / S1).
//
// Home-aware sibling of local:init. Differences from the repo-dev path:
//   • writes $MUNIN_HOME/munin.env (NOT a repo .env, NOT named .env), so it
//     never collides with the repo's authoritative .env;
//   • the starter OMITS PGLITE_DATA_DIR / BLOB_STORAGE_FS_ROOT — those are
//     DERIVED from MUNIN_HOME by the launcher/doctor/wrappers, so the whole
//     home relocates cleanly (a baked-in absolute path would break on move);
//   • the assessment of an existing munin.env therefore does NOT require the
//     data-path lines (requireDataPaths:false), but still validates them if
//     present (escape hatch).
//
// The tenant-provisioning core (ensureLocalTenant — open PGlite at $home/pgdata,
// run migrations, ensure exactly one live tenant) and the 0600 secret writer
// are reused verbatim from local-init.ts. Idempotent re-run: an existing
// complete munin.env is left untouched and its tenant reused.

import fs from 'node:fs';

import { type MuninHomeLayout, muninHomeLayout } from '@muninhq/shared';

import {
  DEFAULT_CONFIG_PACKAGE,
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  type EnvAssessment,
  LocalInitRefusalError,
  assessExistingEnv,
  ensureLocalTenant,
  generateBlobEncryptionKey,
  writeSecretEnvFile,
} from './local-init';

// ---------------------------------------------------------------------------
// Pure: home starter template (no absolute data-dir lines)
// ---------------------------------------------------------------------------

export interface HomeStarterOptions {
  readonly encryptionKey: string;
  readonly tenantId: string;
}

export function renderHomeStarterEnv(opts: HomeStarterOptions): string {
  return `# Munin — local memory home. Written by \`munin init\`.
# Posture: FULLY LOCAL — database, blobs, and AI models all stay on this
# machine; the engine refuses any provider that would send data off it.
# munin init never edits this file once it exists. It is mode 0600 because it
# holds the at-rest blob encryption key below.
#
# This is the ONE file to edit to change what Munin points at. The data dirs
# (pgdata/, blobs/) live alongside it under MUNIN_HOME and are derived from it —
# do NOT add PGLITE_DATA_DIR / BLOB_STORAGE_FS_ROOT here, or moving MUNIN_HOME
# to a new path would break them.

# --- Data store: PGlite (Postgres-in-WASM, in-process, single connection) ---
GRAPH_STORE=local

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
OLLAMA_EMBEDDING_MODEL=${DEFAULT_OLLAMA_EMBEDDING_MODEL}

# --- Blobs: encrypted files on disk (AES-256-GCM, mandatory in local mode) ---
BLOB_STORAGE_IMPL=filesystem
# At-rest key for the blobs. Do NOT rotate or lose it — every stored document
# is encrypted with this key, and a new key orphans them all.
MUNIN_BLOB_ENCRYPTION_KEY=${opts.encryptionKey}

# --- Configuration (entity schemas, terminology, retrieval defaults) ---------
EXTRACTION_CONFIG_PACKAGE=${DEFAULT_CONFIG_PACKAGE}
MUNIN_CONFIG_PACKAGE=${DEFAULT_CONFIG_PACKAGE}

# --- Your local tenant (provisioned by munin init) ---------------------------
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
// Home-aware assessment + refusal report (reuse the repo-mode validator)
// ---------------------------------------------------------------------------

export function assessHomeEnv(content: string, layout: MuninHomeLayout): EnvAssessment {
  return assessExistingEnv(content, {
    pgliteDataDir: layout.pgliteDataDir,
    blobFsRoot: layout.blobFsRoot,
    baseDir: layout.home,
    requireDataPaths: false,
  });
}

function formatHomeRefusalReport(envPath: string, assessment: EnvAssessment): string[] {
  const lines = [
    `${envPath} already exists — munin init never edits an existing munin.env.`,
    'It does not describe a complete local setup. Add or fix these lines by hand:',
  ];
  for (const m of assessment.missing) lines.push(`  + ${m}    (missing)`);
  for (const c of assessment.conflicts) {
    lines.push(`  ~ ${c.key}=${c.expected}    (currently: ${c.actual})`);
  }
  lines.push('Then re-run munin init. (Or move the munin.env aside and re-run for a fresh one.)');
  return lines;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface HomeInitOptions {
  // Absolute home directory (default ~/.munin, resolved by the caller).
  readonly home: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
}

export interface HomeInitResult {
  readonly home: string;
  readonly envPath: string;
  readonly tenantId: string;
  readonly tenantCreated: boolean;
  readonly wroteEnv: boolean;
  readonly pgliteDataDir: string;
  readonly blobFsRoot: string;
  readonly configPackage: string;
}

export async function runHomeInit(opts: HomeInitOptions): Promise<HomeInitResult> {
  const log = opts.log ?? (() => {});
  const baseEnv = opts.baseEnv ?? process.env;
  const layout = muninHomeLayout(opts.home);
  fs.mkdirSync(layout.pgliteDataDir, { recursive: true });
  fs.mkdirSync(layout.blobFsRoot, { recursive: true });

  let existing: string | undefined;
  try {
    existing = fs.readFileSync(layout.envPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (existing !== undefined) {
    const assessment = assessHomeEnv(existing, layout);
    if (!assessment.ok) {
      throw new LocalInitRefusalError(formatHomeRefusalReport(layout.envPath, assessment));
    }
    const { tenantId, created } = await ensureLocalTenant(
      layout.pgliteDataDir,
      assessment.tenantId,
      baseEnv,
    );
    log(`existing ${layout.envPath} already describes this local setup — left untouched`);
    log(
      created
        ? `tenant ${tenantId} re-provisioned in the local store (row was absent)`
        : `tenant ${tenantId} already provisioned — reusing it`,
    );
    return {
      home: layout.home,
      envPath: layout.envPath,
      tenantId,
      tenantCreated: created,
      wroteEnv: false,
      pgliteDataDir: layout.pgliteDataDir,
      blobFsRoot: layout.blobFsRoot,
      configPackage: assessment.configPackage ?? DEFAULT_CONFIG_PACKAGE,
    };
  }

  // Fresh setup: provision the tenant first (opening the store runs the
  // migrations), then write the starter munin.env exactly once at mode 0600.
  const encryptionKey = generateBlobEncryptionKey();
  const { tenantId, created } = await ensureLocalTenant(layout.pgliteDataDir, undefined, baseEnv);
  const starter = renderHomeStarterEnv({ encryptionKey, tenantId });
  writeSecretEnvFile(layout.envPath, starter);
  log(`wrote ${layout.envPath} (fully-local posture; blob encryption key generated; mode 0600)`);
  log(
    created
      ? `tenant ${tenantId} provisioned in the local store at ${layout.pgliteDataDir}`
      : `tenant ${tenantId} already existed in the local store — reused`,
  );
  return {
    home: layout.home,
    envPath: layout.envPath,
    tenantId,
    tenantCreated: created,
    wroteEnv: true,
    pgliteDataDir: layout.pgliteDataDir,
    blobFsRoot: layout.blobFsRoot,
    configPackage: DEFAULT_CONFIG_PACKAGE,
  };
}
