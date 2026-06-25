// Filesystem loader for demo packs.
//
// Reads `<repoRoot>/demo-packs/<name>/pack.json`, validates the manifest,
// and resolves the docs root + ingest groups to absolute paths. Used by the
// CLI seeder and the web sandbox-mode bootstrap.
//
// Server-only — uses node:fs. Shared keeps no other FS imports; this is the
// one allowed exception because demo packs are a workspace-level artefact,
// not a runtime client concern.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  DemoPackError,
  type DemoPackManifest,
  type LoadedDemoPack,
  demoPackTenantId,
  validateDemoPackManifest,
} from './demo-pack';

/**
 * Default demo-packs directory: `<repoRoot>/demo-packs`. Callers can override
 * for tests.
 */
export function defaultDemoPacksDir(repoRoot: string): string {
  return path.join(repoRoot, 'demo-packs');
}

/**
 * Load a single pack by directory name.
 *
 * @param packsDir Absolute path to the `demo-packs/` directory.
 * @param name Pack directory name (must match `pack.json#name`).
 */
export function loadDemoPack(packsDir: string, name: string): LoadedDemoPack {
  const packDir = path.join(packsDir, name);
  const manifestPath = path.join(packDir, 'pack.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      throw new DemoPackError(`demo pack "${name}" not found at ${manifestPath}`);
    }
    throw new DemoPackError(
      `demo pack "${name}": failed to parse ${manifestPath}: ${(err as Error).message}`,
    );
  }
  const manifest = validateDemoPackManifest(raw, manifestPath);
  if (manifest.name !== name) {
    throw new DemoPackError(
      `${manifestPath}: "name" (${manifest.name}) must match the parent directory name (${name})`,
    );
  }

  const docsDir = resolveDocsDir(packDir, manifest);
  const ingestGroups = resolveIngestGroups(docsDir, manifest);
  return {
    manifest,
    manifestPath,
    packDir,
    docsDir,
    ingestGroups,
    tenantId: demoPackTenantId(manifest.name),
  };
}

/**
 * Enumerate pack directory names under `packsDir` without loading or
 * validating any manifests. Returns `[]` when the directory does not exist.
 *
 * Exists so a resilient consumer (e.g. the web sandbox picker) can try-load
 * each pack independently and degrade gracefully on a malformed manifest
 * without inheriting `loadAllDemoPacks`'s fail-fast contract. The CLI seeder
 * keeps the fail-fast path; the web picker uses this helper plus per-entry
 * `loadDemoPack` in a try/catch.
 */
export function listDemoPackEntries(packsDir: string): readonly string[] {
  let entries: string[];
  try {
    entries = readdirSync(packsDir);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries.sort()) {
    const full = path.join(packsDir, entry);
    try {
      if (statSync(full).isDirectory()) names.push(entry);
    } catch {
      // unreadable entry — skip
    }
  }
  return names;
}

/**
 * List + load every pack in the demo-packs directory. Packs with an
 * unreadable / invalid manifest are surfaced via thrown error (fail-fast —
 * the operator should fix the manifest, not silently get a half-list).
 *
 * Personal packs whose docs directory is empty are still loaded (they're
 * meant to be developer-populated). The seeder can decide whether to skip.
 */
export function loadAllDemoPacks(packsDir: string): readonly LoadedDemoPack[] {
  let entries: string[];
  try {
    entries = readdirSync(packsDir);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const packs: LoadedDemoPack[] = [];
  for (const entry of entries.sort()) {
    const full = path.join(packsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    packs.push(loadDemoPack(packsDir, entry));
  }
  return packs;
}

function resolveDocsDir(packDir: string, manifest: DemoPackManifest): string {
  if (manifest.docsPath) {
    // Resolved relative to the pack root. Allows referencing an out-of-tree
    // corpus (e.g. the HR spike fixtures) without duplicating files.
    return path.resolve(packDir, manifest.docsPath);
  }
  return path.join(packDir, 'docs');
}

function resolveIngestGroups(
  docsDir: string,
  manifest: DemoPackManifest,
): readonly { readonly dir: string; readonly accessTags: readonly string[] }[] {
  if (manifest.ingestGroups && manifest.ingestGroups.length > 0) {
    return manifest.ingestGroups.map((g) => ({
      dir: path.resolve(docsDir, g.dir),
      accessTags: g.accessTags,
    }));
  }
  return [{ dir: docsDir, accessTags: manifest.accessTags }];
}
