// Built-in junk filters for codebase ingestion.
//
// The point of this module is the "point Munin at ~/my-repo and get ONLY real
// source, not 50k dependency/build files" behaviour. Three layers, all with
// strong defaults but configurable:
//   1. ignored DIRECTORIES — never descended into (the big win: we don't even
//      walk node_modules/.git/dist, so a huge tree costs nothing);
//   2. ignored FILE globs — lockfiles, minified/generated bundles, sourcemaps,
//      secrets, OS cruft — matched by basename even when their extension is in
//      the allowlist (e.g. `app.min.js` has the allowed `.js` extension);
//   3. a size cap — a generated/vendored file that slips through both is still
//      skipped if it is implausibly large for source.
//
// The extension ALLOWLIST (source-extensions.ts) is the primary gate; these
// rules prune junk that has an allowed extension. They are vertical-agnostic.

import path from 'node:path';

// Directory basenames we never descend into. Dependency, build, VCS, cache and
// editor directories — the bulk of repo "noise". Matched exactly against a
// directory's own name (not arbitrary path segments), so a root the user points
// at explicitly is always honoured.
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  // Version control
  '.git',
  '.hg',
  '.svn',
  '.bzr',
  // JS/TS dependencies, build output, caches
  'node_modules',
  'bower_components',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.yarn',
  '.pnp',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  // Python
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.eggs',
  // Rust / Go / Java / .NET / JVM build output
  'target',
  'vendor',
  'obj',
  '.gradle',
  // Tooling / IDE / infra state
  '.idea',
  '.vscode',
  '.vs',
  '.terraform',
  '.serverless',
  '.expo',
  '.dart_tool',
  // Claude Code tooling state: agents, commands, hooks, settings, and crucially
  // `worktrees/` — full-repo git-worktree copies left by past agent sessions,
  // which otherwise drag in tens of thousands of duplicate files. Repo-root
  // CLAUDE.md lives OUTSIDE `.claude/`, so this does not exclude it.
  '.claude',
  // Munin's OWN local-store directories. `.munin` is the default MUNIN_HOME
  // (holds `pgdata/` + `blobs/`); `.munin-local` is the dev-store convention.
  // Their blobs are AES-GCM-encrypted bytes wearing document extensions (.pdf,
  // .docx), so ingesting them just fails the parser (the "not a readable PDF"
  // dogfooding bug). A suffixed dev variant like `.munin-local.openai-run` is
  // pruned by the prefix rule in isIgnoredDirName (exact-set membership alone
  // would miss it). See the prefix note there.
  '.munin',
  '.munin-local',
]);

// Basename prefixes that mark a Munin local-store directory even with a dotted
// suffix. Scoped TIGHTLY to `.munin-local.` (note the trailing dot) so it
// catches every dev-store variant (`.munin-local.openai-run`, `.munin-local.x`)
// without over-matching an unrelated dir that merely starts with `.munin`
// (e.g. a hypothetical `.munin-notes/` is NOT a store and is left alone). The
// undotted `.munin` / `.munin-local` are covered by the exact set above.
const MUNIN_STORE_DIR_PREFIXES: readonly string[] = ['.munin-local.'];

// Filename globs skipped regardless of extension. `*` matches any run of
// characters within the basename; everything else is literal.
export const DEFAULT_IGNORED_FILE_GLOBS: readonly string[] = [
  // Dependency lockfiles
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  // Minified / bundled / generated assets + sourcemaps
  '*.min.js',
  '*.min.css',
  '*.min.html',
  '*.bundle.js',
  '*.bundle.css',
  '*.map',
  // Compiled / intermediate artefacts
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.o',
  '*.obj',
  '*.a',
  '*.lib',
  // Secrets / credentials / key material (defence-in-depth). Most also lack an
  // allowlisted extension, but these are pinned so a custom `allowedExtensions`
  // can't silently expose them, and so the high-signal cases in allowlisted
  // formats (.tfvars, secrets.yaml, *.json service accounts) are denied.
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.pkcs12',
  '*.keystore',
  '*.jks',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '*.tfvars',
  'secrets.yaml',
  'secrets.yml',
  'secrets.json',
  'credentials.json',
  'service-account.json',
  // Logs and OS cruft
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

// 1 MiB. Real source files are almost always far smaller; anything larger is
// very likely generated, vendored, or data. Configurable per-ingest.
export const DEFAULT_MAX_FILE_SIZE_BYTES = 1_048_576;

export function isIgnoredDirName(
  name: string,
  ignored: ReadonlySet<string> = DEFAULT_IGNORED_DIRS,
): boolean {
  if (ignored.has(name)) return true;
  // Munin's own dotted-suffix local-store dirs (e.g. `.munin-local.openai-run`).
  // Always pruned, even under a custom `ignored` set — ingesting Munin's
  // encrypted blob store is never wanted, and the prefix is too specific to
  // catch anything else. The undotted names live in the exact set above.
  return MUNIN_STORE_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// True when the basename matches any ignore glob.
export function isIgnoredFileName(
  name: string,
  globs: readonly string[] = DEFAULT_IGNORED_FILE_GLOBS,
): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}

// True when the file's extension is in the allowlist. The allowlist is provided
// pre-lowercased by the caller.
export function hasAllowedExtension(name: string, allowed: ReadonlySet<string>): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext.length > 0 && allowed.has(ext);
}

const globCache = new Map<string, RegExp>();

// Translate a simple basename glob (`*` = any run, literal everything else)
// into an anchored, case-sensitive RegExp. Cached because the same handful of
// patterns are tested against every file in a tree.
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  // Collapse runs of '*' to one so a pattern can't emit adjacent unbounded
  // quantifiers (no ReDoS shape, even on caller-supplied globs).
  const body = glob
    .replace(/\*+/g, '*')
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  const re = new RegExp(`^${body}$`);
  globCache.set(glob, re);
  return re;
}
