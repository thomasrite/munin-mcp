// Filesystem connector — walks a local directory tree and yields one
// DocumentSource per file. The connector is vertical-agnostic; ingestion-
// pipeline behaviour (idempotency, parsing, chunking) is identical to what any
// future connector triggers.
//
// Built for codebase ingestion as much as document folders: point it at a repo
// and it yields ONLY real source, not the dependency/build/VCS noise. It does
// this by (a) an extension allowlist of document + source-code formats, (b)
// hard-ignored dependency/build/cache/VCS directories it never even descends
// into, (c) ignored file globs (lockfiles, minified/generated bundles,
// sourcemaps, secrets, OS cruft), (d) a size cap, and (e) optional `.gitignore`
// honouring. Each file's path RELATIVE to the scanned root is preserved as the
// document title + externalId, so retrieval/citations show which file a chunk
// came from.

import type { Dirent, Stats } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  Connector,
  ConnectorContext,
  ConnectorRecord,
  ConnectorTenantConfig,
  DocumentSource,
} from '@muninhq/engine/connectors';

import { GitignoreStack } from './gitignore';
import {
  DEFAULT_IGNORED_DIRS,
  DEFAULT_IGNORED_FILE_GLOBS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  hasAllowedExtension,
  isIgnoredDirName,
  isIgnoredFileName,
} from './ignore-rules';
import { DEFAULT_SOURCE_EXTENSIONS } from './source-extensions';

export { GitignoreStack } from './gitignore';
export {
  DEFAULT_IGNORED_DIRS,
  DEFAULT_IGNORED_FILE_GLOBS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  globToRegExp,
  hasAllowedExtension,
  isIgnoredDirName,
  isIgnoredFileName,
} from './ignore-rules';
export {
  CODE_FILE_EXTENSIONS,
  DEFAULT_DOCUMENT_EXTENSIONS,
  DEFAULT_SOURCE_EXTENSIONS,
} from './source-extensions';

const PACKAGE_NAME = '@muninhq/connector-filesystem';
const HUMAN_NAME = 'Local filesystem';

export interface FilesystemConnectorConfig extends ConnectorTenantConfig {
  // Absolute path of the directory to scan.
  readonly rootPath: string;
  // Extensions (lowercase, with dot) to ingest. Default = every format the
  // engine can parse (documents + source code).
  readonly allowedExtensions?: readonly string[];
  // Recurse into subdirectories. Default true.
  readonly recursive?: boolean;
  // Honour `.gitignore` files found in the tree. Default true.
  readonly respectGitignore?: boolean;
  // Apply the built-in ignored-directory / ignored-file defaults. Default true.
  // (Extras below are always applied.)
  readonly useDefaultIgnores?: boolean;
  // Extra directory basenames to never descend into.
  readonly extraIgnoredDirs?: readonly string[];
  // Extra filename globs to skip.
  readonly extraIgnoredFileGlobs?: readonly string[];
  // Skip files larger than this many bytes. Default 1 MiB; 0 or negative
  // disables the cap.
  readonly maxFileSizeBytes?: number;
}

interface ResolvedFilter {
  readonly allowed: ReadonlySet<string>;
  readonly ignoredDirs: ReadonlySet<string>;
  readonly ignoredFileGlobs: readonly string[];
  readonly respectGitignore: boolean;
  readonly maxFileSizeBytes: number;
}

function isConfig(value: ConnectorTenantConfig): value is FilesystemConnectorConfig {
  return typeof value.rootPath === 'string' && value.rootPath.length > 0;
}

function resolveFilter(config: FilesystemConnectorConfig): ResolvedFilter {
  const useDefaults = config.useDefaultIgnores !== false;
  const allowed = new Set(
    (config.allowedExtensions ?? DEFAULT_SOURCE_EXTENSIONS).map((e) => e.toLowerCase()),
  );
  const ignoredDirs = new Set<string>([
    ...(useDefaults ? DEFAULT_IGNORED_DIRS : []),
    ...(config.extraIgnoredDirs ?? []),
  ]);
  const ignoredFileGlobs = [
    ...(useDefaults ? DEFAULT_IGNORED_FILE_GLOBS : []),
    ...(config.extraIgnoredFileGlobs ?? []),
  ];
  return {
    allowed,
    ignoredDirs,
    ignoredFileGlobs,
    respectGitignore: config.respectGitignore !== false,
    maxFileSizeBytes: config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
  };
}

export const filesystemConnector: Connector = {
  packageName: PACKAGE_NAME,
  humanName: HUMAN_NAME,

  async *list(
    config: ConnectorTenantConfig,
    _ctx: ConnectorContext,
  ): AsyncIterable<ConnectorRecord> {
    if (!isConfig(config)) {
      throw new Error(`${PACKAGE_NAME}: rootPath is required and must be a non-empty string`);
    }
    const filter = resolveFilter(config);
    const recursive = config.recursive !== false;

    for await (const file of walk(config.rootPath, '', recursive, GitignoreStack.empty(), filter)) {
      const document: DocumentSource = {
        // Relative POSIX path from the scanned root — stable across machines and
        // meaningful in citations (e.g. "src/query/context-retriever.ts").
        externalId: file.rel,
        title: file.rel,
        ...(file.mtime !== undefined ? { sourceModifiedAt: file.mtime } : {}),
        async fetchBytes(): Promise<Uint8Array> {
          const buf = await readFile(file.abs);
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },
      };
      yield { kind: 'document', document };
    }
  },
};

interface WalkedFile {
  readonly abs: string;
  readonly rel: string;
  readonly mtime: Date | undefined;
}

async function* walk(
  absDir: string,
  relDir: string,
  recursive: boolean,
  stack: GitignoreStack,
  filter: ResolvedFilter,
): AsyncIterable<WalkedFile> {
  // Fold this directory's own .gitignore into the stack before listing it.
  let dirStack = stack;
  if (filter.respectGitignore) {
    const gitignore = await readFileOrNull(path.join(absDir, '.gitignore'));
    if (gitignore !== null) dirStack = dirStack.withFile(relDir, gitignore);
  }

  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`${PACKAGE_NAME}: cannot read directory ${absDir}: ${(err as Error).message}`);
  }

  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (isIgnoredDirName(entry.name, filter.ignoredDirs)) continue;
      if (filter.respectGitignore && dirStack.isIgnored(rel, true)) continue;
      yield* walk(abs, rel, recursive, dirStack, filter);
      continue;
    }
    // Plain files only — symlinks/sockets/fifos are skipped (avoids cycles).
    if (!entry.isFile()) continue;
    if (!hasAllowedExtension(entry.name, filter.allowed)) continue;
    if (isIgnoredFileName(entry.name, filter.ignoredFileGlobs)) continue;
    if (filter.respectGitignore && dirStack.isIgnored(rel, false)) continue;

    let stats: Stats;
    try {
      stats = await stat(abs);
    } catch {
      continue; // vanished between readdir and stat — skip quietly
    }
    if (filter.maxFileSizeBytes > 0 && stats.size > filter.maxFileSizeBytes) continue;

    yield { abs, rel, mtime: stats.mtime };
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
