// `munin set-key` core (S2 deliverable 5) — one command to switch a local home
// onto a cloud provider for GOOD extraction (and, with OpenAI, FAST cloud
// embeddings), without hand-editing env or fighting MUNIN_LOCAL_MODE.
//
// It is the ONE command whose job is to EDIT munin.env (init/connect never do).
// It writes the provider key at mode 0600, points LLM/EMBEDDING + the models at
// the provider, and flips the posture from fully-local (MUNIN_LOCAL_MODE=true)
// to the BYO-key-laptop posture (MUNIN_ALLOW_CLOUD_PROVIDERS=true — egress
// acknowledged). The key is written to the file and NEVER echoed to stdout.
//
//   anthropic → Claude for extraction + answers; embeddings stay local (Ollama
//               bge-m3) because Anthropic has no embedding API here.
//   openai    → GPT for extraction + answers AND OpenAI cloud embeddings
//               (text-embedding-3-small @ 1024, matching the engine schema).
//
// File-I/O only — no store, no DB. The write is backup + atomic + 0600, and it
// refuses a symlinked env (defence-in-depth, like connect's --write).

import fs from 'node:fs';
import path from 'node:path';

import { muninHomeLayout } from '@muninhq/shared';

import { parseEnvFile } from './local-init';
import { migrateLocalReadAuditOff } from './read-audit-migration';

export type CloudProvider = 'anthropic' | 'openai';

// The extraction/answer models. Track the engine defaults: Sonnet is the repo's
// default LLM; gpt-4.1 is the engine's
// DEFAULT_OPENAI_LLM_MODEL (provider-factory.ts).
export const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
export const OPENAI_MODEL = 'gpt-4.1';

export type KeyVar = 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';

export interface ProviderPlan {
  readonly provider: CloudProvider;
  readonly keyVar: KeyVar;
  readonly llmProvider: CloudProvider;
  readonly embeddingProvider: 'ollama' | 'openai';
  readonly model: string;
  /** Non-secret env updates (everything EXCEPT the api key). */
  readonly envUpdates: Readonly<Record<string, string>>;
}

/** The deterministic, non-secret env changes for a provider (pure — tested). */
export function planProviderEnv(provider: CloudProvider): ProviderPlan {
  // Both postures: cloud AI permitted, fully-local guard off. Models point at
  // the provider so the answer path does not 404 on the local model name.
  if (provider === 'anthropic') {
    return {
      provider,
      keyVar: 'ANTHROPIC_API_KEY',
      llmProvider: 'anthropic',
      embeddingProvider: 'ollama',
      model: ANTHROPIC_MODEL,
      envUpdates: {
        LLM_PROVIDER: 'anthropic',
        // Embeddings stay local — Anthropic has no embedding API here. The
        // existing OLLAMA_EMBEDDING_MODEL (bge-m3) is preserved untouched.
        EMBEDDING_PROVIDER: 'ollama',
        EXTRACTION_MODEL: ANTHROPIC_MODEL,
        ANSWER_MODEL: ANTHROPIC_MODEL,
        GENERATION_MODEL: ANTHROPIC_MODEL,
        MUNIN_LOCAL_MODE: 'false',
        MUNIN_ALLOW_CLOUD_PROVIDERS: 'true',
      },
    };
  }
  return {
    provider,
    keyVar: 'OPENAI_API_KEY',
    llmProvider: 'openai',
    embeddingProvider: 'openai',
    model: OPENAI_MODEL,
    envUpdates: {
      LLM_PROVIDER: 'openai',
      // OpenAI brings its own embeddings (text-embedding-3-small @ 1024 — the
      // factory default, matching the schema). Switching from local bge-m3 means
      // existing vectors must be re-embedded (handled by the re-embed warning).
      EMBEDDING_PROVIDER: 'openai',
      EXTRACTION_MODEL: OPENAI_MODEL,
      ANSWER_MODEL: OPENAI_MODEL,
      GENERATION_MODEL: OPENAI_MODEL,
      MUNIN_LOCAL_MODE: 'false',
      MUNIN_ALLOW_CLOUD_PROVIDERS: 'true',
    },
  };
}

/** Return the key (trimmed) of an uncommented `KEY=...` line, else null. */
function assignedKey(rawLine: string): string | null {
  const trimmed = rawLine.replace(/\r$/, '').trimStart();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  return trimmed.slice(0, eq).trim();
}

/**
 * Upsert KEY=VALUE assignments into env-file CONTENT, preserving comments,
 * blank lines, and every unmanaged assignment. For each managed key: rewrite the
 * FIRST uncommented assignment in place and drop any later duplicates of it;
 * keys with no uncommented assignment are appended in a labelled block.
 * Commented example lines (e.g. `# MUNIN_ALLOW_CLOUD_PROVIDERS=true`) are left
 * untouched. Pure — unit-tested.
 *
 * Assumes the LF, no-`export` env files our writers emit (renderHomeStarterEnv /
 * renderStarterEnv): a CRLF file would gain a mixed-ending rewritten line, and an
 * `export KEY=…` line is not recognised as managing KEY (so a duplicate would be
 * appended). Both are dotenv-consistent and harmless on the realistic path, but
 * the assumption is load-bearing — keep the starter writers LF/no-export.
 */
export function upsertEnvVars(content: string, updates: Readonly<Record<string, string>>): string {
  const keys = new Set(Object.keys(updates));
  const applied = new Set<string>();
  const out: string[] = [];

  const hadTrailingNewline = content.endsWith('\n');
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  for (const rawLine of body.split('\n')) {
    const key = assignedKey(rawLine);
    if (key !== null && keys.has(key)) {
      if (!applied.has(key)) {
        out.push(`${key}=${updates[key]}`);
        applied.add(key);
      }
      // else: a later duplicate of an already-rewritten key — drop it.
      continue;
    }
    out.push(rawLine);
  }

  const missing = [...keys].filter((k) => !applied.has(k));
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push('# --- Cloud provider (added by `munin set-key`) ---');
    for (const k of missing) out.push(`${k}=${updates[k]}`);
  }
  return `${out.join('\n')}\n`;
}

function defaultStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Replace an existing env file atomically at mode 0600, backing up the previous
 * content first. Refuses a symlink target (we never write through links). Used
 * by set-key, whose file CONTAINS the api key.
 */
export function writeEnvFileSecure(
  envPath: string,
  content: string,
  stamp: () => string = defaultStamp,
): { backupPath: string } {
  const lstat = fs.lstatSync(envPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink: ${envPath}`);
  }
  const backupPath = `${envPath}.munin-backup-${stamp()}`;
  fs.copyFileSync(envPath, backupPath, fs.constants.COPYFILE_EXCL);
  // The backup is a copy of the secret file — pin its mode to 0600 explicitly,
  // so the guarantee holds even if the live munin.env was manually loosened.
  fs.chmodSync(backupPath, 0o600);

  const dir = path.dirname(envPath);
  const tmp = path.join(dir, `.munin-set-key-${process.pid}-${stamp()}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, envPath);
  return { backupPath };
}

export interface RunSetKeyOptions {
  readonly home: string;
  readonly provider: CloudProvider;
  /** The api key. Written to the file, never logged or returned. */
  readonly key: string;
  /** Injectable for deterministic backup names in tests. */
  readonly stamp?: () => string;
}

// Deliberately carries NO key — the secret lives only in the file. Everything
// here is safe to print.
export interface SetKeyResult {
  readonly envPath: string;
  readonly provider: CloudProvider;
  readonly llmProvider: string;
  readonly embeddingProvider: string;
  readonly model: string;
  readonly keyVar: KeyVar;
  /** True when the embedding provider changed → vectors must be re-embedded. */
  readonly reEmbedNeeded: boolean;
  readonly backupPath: string;
}

export async function runSetKey(opts: RunSetKeyOptions): Promise<SetKeyResult> {
  const key = opts.key.trim();
  if (key === '') {
    throw new Error('no api key provided (the value was empty)');
  }
  const layout = muninHomeLayout(opts.home);
  if (!fs.existsSync(layout.envPath)) {
    throw new Error(`no munin.env at ${layout.envPath} — run \`munin init\` first`);
  }
  const content = fs.readFileSync(layout.envPath, 'utf8');
  const oldVars = parseEnvFile(content);
  const oldEmbedding = oldVars.get('EMBEDDING_PROVIDER')?.toLowerCase() ?? 'ollama';

  const plan = planProviderEnv(opts.provider);
  const updates = { ...plan.envUpdates, [plan.keyVar]: key };
  // Preserve (and, for an older home, BACK-FILL) the local read-audit-off
  // posture as we rewrite: set-key flips to the cloud-on-laptop posture but keeps
  // GRAPH_STORE=local, so the single-process store's crash-corruption risk is
  // unchanged. migrateLocalReadAuditOff only ADDS the line when absent — it never
  // overrides an explicit MUNIN_READ_AUDIT the user set.
  const baseContent = migrateLocalReadAuditOff(content).content;
  const newContent = upsertEnvVars(baseContent, updates);
  const { backupPath } = writeEnvFileSecure(layout.envPath, newContent, opts.stamp);

  return {
    envPath: layout.envPath,
    provider: opts.provider,
    llmProvider: plan.llmProvider,
    embeddingProvider: plan.embeddingProvider,
    model: plan.model,
    keyVar: plan.keyVar,
    reEmbedNeeded: oldEmbedding !== plan.embeddingProvider,
    backupPath,
  };
}

/** Human-readable summary of what set-key did — carries NO key (redaction). */
export function formatSetKeySummary(r: SetKeyResult): string {
  const lines: string[] = [];
  lines.push(`✓ ${r.provider} key written to ${r.envPath} (mode 0600 — not shown).`);
  lines.push(
    '  posture:    MUNIN_ALLOW_CLOUD_PROVIDERS=true (local store + cloud AI, egress acknowledged)',
  );
  lines.push(`  LLM:        ${r.llmProvider} — extraction + answers via ${r.model}`);
  lines.push(
    r.embeddingProvider === 'ollama'
      ? '  embeddings: ollama bge-m3 (still local — keep Ollama running)'
      : '  embeddings: openai text-embedding-3-small (cloud, 1024-dim)',
  );
  lines.push(`  backup:     ${r.backupPath}`);
  if (r.reEmbedNeeded) {
    lines.push('');
    lines.push('⚠ Embedding provider changed — vectors are NOT comparable across models.');
    lines.push('  Re-embed by re-ingesting: `munin ingest <dir> --force-reingest`');
    lines.push('  (embeddings are generated at ingest). Until then, retrieval may be degraded.');
  }
  lines.push('');
  lines.push('Run `munin mcp doctor` to verify the new posture, then restart your AI client.');
  return lines.join('\n');
}
