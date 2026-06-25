// `munin mcp doctor` core (F68 / S1) — a ✓/✗ checklist that shows the local
// MCP setup is actually wired, so a non-developer can see it works (or see
// exactly what is missing) without reading logs.
//
// Checks: MUNIN_HOME resolves; munin.env exists/parses and declares a posture;
// data dirs present; the PGlite store opens OR is reported as in-use by a live
// AI client (the local store is single-process — a running Claude Desktop /
// Cursor legitimately holds it, which is NORMAL, not a fault); a tenant resolves;
// the configuration + extraction packages load; providers construct (the posture
// guard runs) and,
// in local mode, the Ollama daemon is reachable with the needed models; how
// many tools the server will expose; and which client configs reference `munin`
// and whether they point at THIS home (drift).
//
// REDACTION (load-bearing): doctor prints only posture booleans, the tenant id,
// config/provider NAMES and model NAMES — NEVER MUNIN_BLOB_ENCRYPTION_KEY or any
// *_API_KEY value. A test asserts no secret value appears in the output.
//
// IMPORTS ONLY @muninhq/engine + @muninhq/shared + sibling munin-mcp modules —
// never @muninhq/mcp (that edge is dev/test-only; keeping it one-way avoids a
// build cycle). The MCP tool set is mirrored as a constant below, the same
// deliberate duplication as tenant.ts ↔ local-init.ts.

import fs from 'node:fs';
import path from 'node:path';

import { loadConfigurationWithResolver, loadProvidersFromEnv } from '@muninhq/engine';
import { tenants } from '@muninhq/engine/db/schema';
import { inspectLock, loadGraphStore } from '@muninhq/engine/graph-store';
import { type MuninHomeLayout, muninHomeLayout, resolveMuninHome } from '@muninhq/shared';

import { parseEnvFile } from './local-init';
import { rebuildCommand } from './local-store-errors';
import {
  type McpClient,
  type ResolvePathDeps,
  clientConfigPath,
  defaultPathDeps,
} from './mcp-connect';

// Mirror of the five tools in packages/mcp/src/server.ts — used only to report
// "N tools will be exposed". Kept in sync by review (the same deliberate
// duplication as the tenant-discovery code), since doctor must not import @muninhq/mcp.
export const MCP_TOOL_NAMES = [
  'munin_retrieve_context',
  'munin_ask',
  'munin_gather_entity',
  'munin_get_document',
  'munin_status',
] as const;

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

const GLYPH: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '·' };

export function renderDoctorReport(home: string, checks: readonly DoctorCheck[]): string {
  const lines = [`munin mcp doctor — home: ${home}`, ''];
  for (const c of checks) {
    lines.push(`  ${GLYPH[c.status]} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    failed === 0
      ? warned === 0
        ? 'All checks passed.'
        : `Ready, with ${warned} warning(s) to review above.`
      : `${failed} check(s) failed — see above. Run \`munin init\` if the home is missing.`,
  );
  return lines.join('\n');
}

/** Whether every check passed (no fails). Drives the process exit code. */
export function allChecksOk(checks: readonly DoctorCheck[]): boolean {
  return checks.every((c) => c.status !== 'fail');
}

export interface OllamaPing {
  readonly reachable: boolean;
  readonly models: readonly string[];
}

/**
 * Whether a requested Ollama model is among the pulled tags. Exact match, or —
 * when the request is a bare name (no `:tag`) — any pulled tag of that name
 * (Ollama lists `name:tag`, defaulting to `:latest`). Deliberately does NOT
 * treat a mere prefix as present: requesting `qwen2.5:7b` with only `qwen2`
 * pulled is a MISS (the model would 404 at runtime), not a hit.
 */
export function ollamaModelPresent(want: string, pulled: readonly string[]): boolean {
  return pulled.some(
    (have) => have === want || (!want.includes(':') && have.startsWith(`${want}:`)),
  );
}

/**
 * The reranking status line — a pure helper so it is unit-testable. Reranking is
 * the single biggest retrieval-quality lever, yet it ships OFF by default
 * (RERANK_PROVIDER=none). Surface that loudly as a WARNING (not a failure — the
 * server runs fine without it) so a user understands answer quality is reduced and
 * how to turn it on, without reading the engine source.
 */
export function rerankingCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const id = (env.RERANK_PROVIDER ?? 'none').trim().toLowerCase();
  if (id === '' || id === 'none') {
    return {
      label: 'reranking',
      status: 'warn',
      detail:
        'OFF (RERANK_PROVIDER=none) — answer quality is reduced; reranking is the #1 retrieval-quality knob. Enable a loopback cross-encoder (RERANK_PROVIDER=cross-encoder) — see docs/LOCAL-RUNTIME.md.',
    };
  }
  return { label: 'reranking', status: 'ok', detail: `RERANK_PROVIDER=${id}` };
}

async function defaultOllamaPing(baseUrl: string): Promise<OllamaPing> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { reachable: false, models: [] };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

export interface RunDoctorOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit home override (else resolved from env / ~/.munin). */
  readonly home?: string;
  readonly pathDeps?: ResolvePathDeps;
  /** Injectable Ollama probe (tests avoid a live daemon). */
  readonly ollamaPing?: (baseUrl: string) => Promise<OllamaPing>;
}

interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly deletedAt: Date | null;
}
interface TenantSelect {
  select(fields: {
    id: typeof tenants.id;
    name: typeof tenants.name;
    deletedAt: typeof tenants.deletedAt;
  }): { from(table: typeof tenants): Promise<TenantRow[]> };
}

export interface DoctorReport {
  readonly home: string;
  readonly layout: MuninHomeLayout;
  readonly checks: readonly DoctorCheck[];
}

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorReport> {
  const baseEnv = opts.env ?? process.env;
  const home = opts.home ?? resolveMuninHome(baseEnv);
  const layout = muninHomeLayout(home);
  const checks: DoctorCheck[] = [];
  const add = (label: string, status: CheckStatus, detail?: string): void => {
    checks.push(detail === undefined ? { label, status } : { label, status, detail });
  };

  add('MUNIN_HOME resolves', 'ok', home);

  // --- munin.env -----------------------------------------------------------
  const envExists = fs.existsSync(layout.envPath);
  if (!envExists) {
    add('munin.env present', 'fail', `not found at ${layout.envPath} — run \`munin init\``);
    return { home, layout, checks };
  }
  add('munin.env present', 'ok', layout.envPath);

  // Compose the effective env: munin.env over the ambient env (mirrors the
  // launcher), so subsequent checks see what the server would see.
  const fileVars = parseEnvFile(fs.readFileSync(layout.envPath, 'utf8'));
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [k, v] of fileVars) env[k] = v;
  if (!env.PGLITE_DATA_DIR?.trim()) env.PGLITE_DATA_DIR = layout.pgliteDataDir;
  if (!env.BLOB_STORAGE_FS_ROOT?.trim()) env.BLOB_STORAGE_FS_ROOT = layout.blobFsRoot;

  const localMode = env.MUNIN_LOCAL_MODE?.toLowerCase() === 'true';
  const allowCloud = env.MUNIN_ALLOW_CLOUD_PROVIDERS?.toLowerCase() === 'true';
  if (localMode) add('posture declared', 'ok', 'MUNIN_LOCAL_MODE=true (fully local, zero egress)');
  else if (allowCloud)
    add('posture declared', 'ok', 'MUNIN_ALLOW_CLOUD_PROVIDERS=true (local store + cloud AI)');
  else
    add(
      'posture declared',
      'fail',
      'set MUNIN_LOCAL_MODE=true or MUNIN_ALLOW_CLOUD_PROVIDERS=true',
    );

  // --- data dirs -----------------------------------------------------------
  const pgExists = fs.existsSync(layout.pgliteDataDir);
  const blobExists = fs.existsSync(layout.blobFsRoot);
  add(
    'data directories present',
    pgExists && blobExists ? 'ok' : 'warn',
    `pgdata=${pgExists} blobs=${blobExists}`,
  );

  // --- store opens + tenant resolves --------------------------------------
  // The local store is single-process: while the user's AI client (Claude
  // Desktop / Cursor) is running, its MCP server legitimately HOLDS the store
  // via the F71 advisory lock. That is NORMAL, not a fault — so before any open
  // we probe the lock read-only (inspectLock never opens PGlite, so it cannot
  // corrupt a held data dir) and, if a live holder is present, report an
  // informational line instead of a scary "locked or corrupt" failure. We only
  // attempt a real open when no live holder is detected.
  let storeOk = false;
  const isLocal = (env.GRAPH_STORE ?? '').toLowerCase() === 'local';
  // Mirror the factory's data-dir resolution; env.PGLITE_DATA_DIR was defaulted
  // to layout.pgliteDataDir above, so it is set in the local home case.
  const liveHolder = isLocal ? inspectLock(env.PGLITE_DATA_DIR ?? '') : null;
  if (liveHolder !== null) {
    add(
      'local store',
      'skip',
      `in use by your AI client (pid ${liveHolder.heldByLivePid}); this is normal while Claude Desktop or Cursor is running`,
    );
    // We deliberately do NOT open the held store (that is what risks corruption),
    // so we cannot enumerate tenants here. Report the dependent checks as
    // informational rather than failed — the server itself proves them at boot.
    add('tenant resolves', 'skip', 'not checked while the store is in use by your AI client');
  } else {
    try {
      const handle = await loadGraphStore(env);
      try {
        const db = handle.db as unknown as TenantSelect;
        const rows = await db
          .select({ id: tenants.id, name: tenants.name, deletedAt: tenants.deletedAt })
          .from(tenants);
        const live = rows.filter((r) => r.deletedAt === null);
        storeOk = true;
        add('local store opens', 'ok', `GRAPH_STORE=${env.GRAPH_STORE ?? 'postgres'}`);

        const pinned = env.MUNIN_TENANT_ID?.trim();
        if (pinned) {
          // Verify the pinned id actually names a live tenant — a stale
          // MUNIN_TENANT_ID (wiped/soft-deleted store) would otherwise show green
          // here yet fail the server's own resolveTenant at boot.
          if (live.some((t) => t.id === pinned))
            add('tenant resolves', 'ok', `${pinned} (from MUNIN_TENANT_ID)`);
          else
            add(
              'tenant resolves',
              'fail',
              `MUNIN_TENANT_ID=${pinned} names no live tenant in this store — run \`munin init\``,
            );
        } else if (live.length === 1 && live[0])
          add('tenant resolves', 'ok', `${live[0].id} (single live tenant)`);
        else if (live.length === 0)
          add('tenant resolves', 'fail', 'no live tenant — run `munin init`');
        else add('tenant resolves', 'warn', `${live.length} tenants — set MUNIN_TENANT_ID`);
      } finally {
        await handle.close();
      }
    } catch (err) {
      // A live holder that appeared BETWEEN the probe and the open (a race: the
      // client started just now) surfaces as the typed LocalStoreLockedError —
      // treat it as the same informational "in use" state, never a failure.
      if ((err as Error).name === 'LocalStoreLockedError') {
        add(
          'local store',
          'skip',
          'in use by your AI client; this is normal while Claude Desktop or Cursor is running',
        );
        add('tenant resolves', 'skip', 'not checked while the store is in use by your AI client');
      } else {
        // Genuinely unopenable with no live holder — the real corrupt/locked case.
        // One-command rebuild prompt, consistent with the CLI's reportLocalStoreError.
        add(
          'local store opens',
          'fail',
          `${(err as Error).message} (if no AI client is running, the local store is likely corrupt — rebuild with \`${rebuildCommand(env.PGLITE_DATA_DIR)}\`)`,
        );
      }
    }
  }

  // --- configuration loads -------------------------------------------------
  const configPkg = env.MUNIN_CONFIG_PACKAGE?.trim();
  if (!configPkg) add('configuration package', 'fail', 'MUNIN_CONFIG_PACKAGE unset');
  else {
    try {
      const cfg = await loadConfigurationWithResolver(configPkg, (p) => import(p));
      add('configuration loads', 'ok', `${configPkg} (${cfg.id} v${cfg.version})`);
    } catch (err) {
      add('configuration loads', 'fail', `${configPkg}: ${(err as Error).message}`);
    }
  }
  const extractionPkg = env.EXTRACTION_CONFIG_PACKAGE?.trim();
  add(
    'extraction config package',
    extractionPkg ? 'ok' : 'warn',
    extractionPkg ?? 'EXTRACTION_CONFIG_PACKAGE unset — the local graph will not build',
  );

  // --- providers + Ollama --------------------------------------------------
  const llm = env.LLM_PROVIDER ?? '(default)';
  const embedding = env.EMBEDDING_PROVIDER ?? '(default)';
  try {
    loadProvidersFromEnv(env);
    add('providers configured', 'ok', `LLM=${llm} EMBEDDING=${embedding}`);
  } catch (err) {
    add(
      'providers configured',
      'fail',
      `LLM=${llm} EMBEDDING=${embedding}: ${(err as Error).message}`,
    );
  }

  if (llm === 'ollama' || embedding === 'ollama') {
    const baseUrl = env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
    const ping = await (opts.ollamaPing ?? defaultOllamaPing)(baseUrl);
    if (!ping.reachable) {
      add(
        'Ollama reachable',
        'warn',
        `${baseUrl} not reachable — start Ollama (https://ollama.com)`,
      );
    } else {
      add('Ollama reachable', 'ok', baseUrl);
      const want = [env.OLLAMA_MODEL, env.OLLAMA_EMBEDDING_MODEL].filter((m): m is string =>
        Boolean(m?.trim()),
      );
      const missing = want.filter((m) => !ollamaModelPresent(m, ping.models));
      add(
        'Ollama models pulled',
        missing.length === 0 ? 'ok' : 'warn',
        missing.length === 0
          ? want.join(', ')
          : `missing: ${missing.join(', ')} (run \`ollama pull <model>\`)`,
      );
    }
  }

  // Reranking — the #1 retrieval-quality knob, OFF by default. Reported after
  // providers so a user sees plainly whether answer quality is at its best.
  checks.push(rerankingCheck(env));

  add('MCP tools exposed', storeOk ? 'ok' : 'skip', `${MCP_TOOL_NAMES.length} tools`);

  // --- client wiring + drift ----------------------------------------------
  const deps = opts.pathDeps ?? defaultPathDeps(baseEnv);
  for (const client of ['claude-desktop', 'cursor'] as McpClient[]) {
    const cfgPath = clientConfigPath({ client }, deps);
    const wiring = inspectClientWiring(cfgPath, home);
    add(`${client} wiring`, wiring.status, wiring.detail);
  }

  return { home, layout, checks };
}

export interface Wiring {
  readonly status: CheckStatus;
  readonly detail: string;
}

export function inspectClientWiring(cfgPath: string, home: string): Wiring {
  if (!fs.existsSync(cfgPath)) return { status: 'skip', detail: `no config at ${cfgPath}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return { status: 'warn', detail: `${cfgPath} is not valid JSON` };
  }
  const servers =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).mcpServers
      : undefined;
  const entry =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? (servers as Record<string, unknown>).munin
      : undefined;
  if (!entry || typeof entry !== 'object') {
    return {
      status: 'skip',
      detail: `no \`munin\` entry in ${cfgPath} — run \`munin mcp connect --write\``,
    };
  }
  const envBlock = (entry as Record<string, unknown>).env;
  const pointedHome =
    envBlock && typeof envBlock === 'object'
      ? (envBlock as Record<string, unknown>).MUNIN_HOME
      : undefined;
  if (typeof pointedHome === 'string' && pointedHome !== home) {
    return {
      status: 'warn',
      detail: `points at a different home (${pointedHome}) — re-run connect to update`,
    };
  }
  // Recognise BOTH launcher forms — the installed `munin-mcp` bin (`<node>
  // <…/dist/main.js>`) and the dev checkout (`pnpm --dir <repo>/packages/mcp …`)
  // — and validate that the executable it points at still exists on disk, so a
  // stale block (a removed checkout or uninstalled package) surfaces as a warning
  // rather than a silent runtime "Server disconnected".
  const launcher = classifyClientLauncher(entry as Record<string, unknown>);
  if (launcher.targetPath !== undefined && !fs.existsSync(launcher.targetPath)) {
    return {
      status: 'warn',
      detail: `${launcher.label} launcher points at a missing path (${launcher.targetPath}) — re-run \`munin mcp connect\``,
    };
  }
  return { status: 'ok', detail: `\`munin\` → ${home} (${launcher.label})` };
}

interface LauncherClassification {
  /** Human-facing label for the form (used in the doctor detail line). */
  readonly label: string;
  /** The executable/dir the launcher points at, validated for existence; absent
   *  when the form is unrecognised (an externally hand-edited entry). */
  readonly targetPath?: string;
}

/**
 * Classify a client `munin` entry's launcher as the INSTALLED-bin form, the dev
 * CHECKOUT form, or an unrecognised hand-edited shape — and extract the path it
 * points at so doctor can confirm the target exists. The discriminator is the
 * args array: a checkout launcher carries `--dir <mcpDir>`; an installed launcher
 * runs an absolute `…/dist/main.js` directly.
 */
function classifyClientLauncher(entry: Record<string, unknown>): LauncherClassification {
  const args = Array.isArray(entry.args)
    ? entry.args.filter((a): a is string => typeof a === 'string')
    : [];
  const dirIdx = args.indexOf('--dir');
  const dirValue = dirIdx !== -1 ? args[dirIdx + 1] : undefined;
  if (dirValue !== undefined) {
    return { label: 'repo checkout', targetPath: dirValue };
  }
  const binArg = args.find((a) => path.isAbsolute(a) && a.endsWith('.js'));
  if (binArg !== undefined) {
    return { label: 'installed munin-mcp bin', targetPath: binArg };
  }
  return { label: 'custom launcher' };
}
