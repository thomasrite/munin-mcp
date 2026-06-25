// Demo-pack manifest schema — used by the sandbox.
//
// A demo pack is a top-level `demo-packs/<name>/` directory that pairs an
// @muninhq configuration package with a corpus of ingestable documents and a
// short bit of UX metadata (description, suggested prompts, pre-set access
// tags). The CLI's `demo:seed`/`demo:reset` and the web sandbox mode both
// read packs through `loadDemoPack` / `loadAllDemoPacks` below.
//
// The schema is vertical-agnostic: a pack declares `configPackage` (the
// configuration to load) and ingest groups. Engine + shared know nothing
// about HR, orgs, projects, or any other concept the pack might surface.
//
// Validation style matches the rest of `@muninhq/shared` (config-compose etc.):
// plain TS predicates throwing typed errors. No Ajv/zod dep added here.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

/**
 * An ingest group inside a pack — a subdirectory of documents that share an
 * access-tag set. Mirrors the engine demo harness's `IngestGroup` shape.
 *
 * `dir` is resolved relative to `docsDir` (or `docsPath` if the pack uses an
 * out-of-tree reference). For single-group packs the convention is
 * `dir: '.'` (i.e. the whole docs root).
 */
export interface DemoPackIngestGroup {
  /** Subdirectory of the pack's docs root. `'.'` for the whole root. */
  readonly dir: string;
  /** Access tags assigned to documents ingested from this subdirectory. */
  readonly accessTags: readonly string[];
}

/**
 * A demo pack's `pack.json`.
 *
 * - `name` must match the parent directory name (asserted at load time).
 * - `configPackage` is the @muninhq configuration package to dynamic-import.
 * - `description` is shown in the sandbox's "Choose a demo" picker.
 * - `suggestedPrompts` populate the chat suggestions (UX hint, optional).
 * - `accessTags` is the pack-wide default tag set (used when ingest groups
 *   don't override). Empty means each group must declare its own.
 * - `ingestGroups` enumerates subdirectories + tags; falls back to a single
 *   implicit group rooted at the docs dir with `accessTags` when omitted.
 * - `docsPath` (optional) overrides the default `./docs` subdirectory with
 *   a path relative to the pack root. Lets a pack reference an out-of-tree
 *   corpus (e.g. the HR spike fixtures) without duplicating files.
 */
export interface DemoPackManifest {
  readonly name: string;
  readonly configPackage: string;
  readonly description: string;
  readonly suggestedPrompts: readonly string[];
  readonly accessTags: readonly string[];
  readonly ingestGroups?: readonly DemoPackIngestGroup[];
  readonly docsPath?: string;
}

/**
 * A loaded demo pack: the validated manifest plus the resolved absolute paths
 * the seeder needs. `tenantId` is deterministically derived from `name` so
 * re-runs of `demo:seed` reuse the same Munin tenant.
 */
export interface LoadedDemoPack {
  readonly manifest: DemoPackManifest;
  /** Absolute path to the `pack.json` file. */
  readonly manifestPath: string;
  /** Absolute path to the pack root directory. */
  readonly packDir: string;
  /** Absolute path to the resolved docs directory (may be outside the pack). */
  readonly docsDir: string;
  /** Resolved ingest groups (absolute `dir` per group, default applied). */
  readonly ingestGroups: readonly {
    readonly dir: string;
    readonly accessTags: readonly string[];
  }[];
  /** Deterministic UUID derived from `manifest.name` — the sandbox tenant. */
  readonly tenantId: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DemoPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoPackError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Validate a parsed JSON object as a `DemoPackManifest`. Throws
 * `DemoPackError` with a precise path on the first failure (fail-fast — the
 * loader's caller is an operator, not a runtime client).
 */
export function validateDemoPackManifest(raw: unknown, source: string): DemoPackManifest {
  if (!isPlainObject(raw)) {
    throw new DemoPackError(`${source}: pack manifest must be a JSON object`);
  }
  const name = requireString(raw, 'name', source);
  if (!NAME_RE.test(name)) {
    throw new DemoPackError(
      `${source}: "name" must match ${NAME_RE} (lowercase, hyphens, no leading digit), got "${name}"`,
    );
  }
  const configPackage = requireString(raw, 'configPackage', source);
  if (!configPackage.startsWith('@') && !configPackage.includes('/')) {
    // Permissive — workspace packages are scoped, but a relative-path import
    // is also fine. Bare names that look like npm packages we leave alone.
  }
  const description = requireString(raw, 'description', source);
  const suggestedPrompts = requireStringArray(raw, 'suggestedPrompts', source);
  const accessTags = requireStringArray(raw, 'accessTags', source);

  let ingestGroups: readonly DemoPackIngestGroup[] | undefined;
  if (raw.ingestGroups !== undefined) {
    if (!Array.isArray(raw.ingestGroups)) {
      throw new DemoPackError(`${source}: "ingestGroups" must be an array if present`);
    }
    ingestGroups = raw.ingestGroups.map((g, i) =>
      validateIngestGroup(g, `${source}.ingestGroups[${i}]`),
    );
    if (ingestGroups.length === 0) {
      throw new DemoPackError(`${source}: "ingestGroups" must not be empty when provided`);
    }
  } else {
    // Implicit single group is allowed only if pack-wide accessTags is non-empty.
    if (accessTags.length === 0) {
      throw new DemoPackError(
        `${source}: either "ingestGroups" or non-empty "accessTags" is required (no implicit untagged ingest)`,
      );
    }
  }

  const docsPath = raw.docsPath === undefined ? undefined : requireString(raw, 'docsPath', source);

  return {
    name,
    configPackage,
    description,
    suggestedPrompts,
    accessTags,
    ...(ingestGroups ? { ingestGroups } : {}),
    ...(docsPath ? { docsPath } : {}),
  };
}

function validateIngestGroup(raw: unknown, source: string): DemoPackIngestGroup {
  if (!isPlainObject(raw)) {
    throw new DemoPackError(`${source}: must be an object`);
  }
  const dir = requireString(raw, 'dir', source);
  const accessTags = requireStringArray(raw, 'accessTags', source);
  if (accessTags.length === 0) {
    throw new DemoPackError(`${source}.accessTags: must be non-empty`);
  }
  return { dir, accessTags };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(raw: Record<string, unknown>, key: string, source: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DemoPackError(`${source}: "${key}" is required and must be a non-empty string`);
  }
  return v;
}

function requireStringArray(
  raw: Record<string, unknown>,
  key: string,
  source: string,
): readonly string[] {
  const v = raw[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new DemoPackError(`${source}: "${key}" is required and must be an array of strings`);
  }
  return v as readonly string[];
}

// ---------------------------------------------------------------------------
// Deterministic tenant UUID
// ---------------------------------------------------------------------------

/**
 * Deterministic UUID v5-ish derived from the pack name. Same name → same
 * tenant id, so `demo:seed` re-runs are idempotent at the tenant level.
 *
 * We hash with a fixed namespace string and format as a UUID. Not a
 * cryptographic identifier — just a stable, collision-free-enough mapping
 * inside the sandbox.
 */
export function demoPackTenantId(name: string): string {
  const NAMESPACE = 'munin:demo-pack:v1';
  const hash = createHash('sha256').update(`${NAMESPACE}:${name}`).digest('hex');
  // Format as a UUID (8-4-4-4-12), forcing version 5 + variant bits to keep
  // it valid per RFC 4122.
  const b = hash.slice(0, 32).split('');
  // version: nibble 12 := '5'
  b[12] = '5';
  // variant: nibble 16 ∈ {8,9,a,b}
  b[16] = (((Number.parseInt(b[16] ?? '0', 16) & 0x3) | 0x8) >>> 0).toString(16);
  const s = b.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
