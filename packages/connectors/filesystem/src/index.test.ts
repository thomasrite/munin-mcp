import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ConnectorContext, ConnectorRecord } from '@muninhq/engine/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FilesystemConnectorConfig, filesystemConnector } from './index';

// The connector never touches the context.
const CTX = undefined as unknown as ConnectorContext;

let root: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function collect(config: FilesystemConnectorConfig): Promise<string[]> {
  const out: string[] = [];
  for await (const rec of filesystemConnector.list(config, CTX) as AsyncIterable<ConnectorRecord>) {
    if (rec.kind === 'document') out.push(rec.document.externalId);
  }
  return out.sort();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'munin-fs-conn-'));

  // Real source the connector SHOULD pick up.
  await write('src/app.ts', 'export const app = () => 1;\n');
  await write('src/util/helpers.py', 'def helper():\n    return 2\n');
  await write('cmd/main.go', 'package main\nfunc main() {}\n');
  await write('config/settings.yaml', 'key: value\n');
  await write('package.json', '{ "name": "demo" }\n');
  await write('README.md', '# Demo\n\nText.\n');
  // Repo-root CLAUDE.md lives OUTSIDE `.claude/`, so the `.claude` dir prune
  // does NOT exclude it — it's a real document and must still be picked up.
  await write('CLAUDE.md', '# Project context\n\nReal content.\n');
  await write('notes.txt', 'a note\n');

  // Junk the connector SHOULD skip.
  await write('node_modules/dep/index.js', 'module.exports = {};\n'); // ignored dir
  await write('.git/config', '[core]\n'); // ignored dir
  await write('dist/bundle.js', 'console.log(1)\n'); // ignored dir
  await write('src/vendor/lib.js', 'x\n'); // ignored dir (nested)
  // Claude Code tooling state: `.claude/worktrees/<copy>/` holds full-repo
  // worktree copies left by past agent sessions — never descended into.
  await write('.claude/worktrees/copy/foo.ts', 'export const foo = 1;\n'); // ignored dir
  await write('.claude/settings.json', '{ "ignore": true }\n'); // ignored dir
  // Munin's own local-store dirs — AES-GCM-encrypted blobs wearing doc
  // extensions, plus pgdata. Never walked (the dogfooding "not a readable PDF"
  // bug). Covers the dotted-suffix dev variant AND the default `.munin` home.
  // The blobs carry an allowlisted extension (.md), so only DIRECTORY pruning —
  // not the extension gate — keeps them out; that is the behaviour under test.
  await write('.munin-local.openai-run/blobs/ab/cd.md', 'ENCRYPTED-BYTES\n'); // ignored dir (suffix)
  await write('.munin/pgdata/base/relation.md', 'PGDATA\n'); // ignored dir (default home)
  await write('.munin/blobs/ef/gh.md', 'ENCRYPTED-BYTES\n'); // ignored dir (default home)
  // A real doc sitting next to a Munin store (basename only starts with
  // `.munin`) must still be picked up — the prune must not over-match.
  await write('.munin-notes/real.md', '# Real notes\n'); // NOT a store — walked
  await write('pnpm-lock.yaml', 'lockfileVersion: 9\n'); // lockfile glob
  await write('app.min.js', 'var a=1;\n'); // minified glob (allowed .js ext)
  await write('bundle.js.map', '{}\n'); // sourcemap glob
  await write('.env', 'SECRET=1\n'); // secret glob + not in default ext
  await write('terraform.tfvars', 'db_password = "p"\n'); // secret glob (allowlisted ext)
  await write('server.pem', '-----BEGIN KEY-----\n'); // secret glob
  await write('logo.png', 'binary-ish\n'); // not an allowed extension
  await write('big.ts', 'x'.repeat(2000)); // over the size cap below

  // .gitignore-driven exclusion.
  await write('.gitignore', 'generated-client.ts\nscratch/\n');
  await write('generated-client.ts', 'export const gen = 1;\n');
  await write('scratch/throwaway.ts', 'export const t = 1;\n');

  // Symlinks are skipped (no cycles, no escape-the-root). `alias.ts` points at a
  // real source file; `selfloop` is a directory symlink back to the root.
  await symlink(path.join(root, 'src/app.ts'), path.join(root, 'alias.ts'));
  await symlink(root, path.join(root, 'selfloop'), 'dir');
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('filesystemConnector — codebase selection', () => {
  it('yields only real source, skipping deps/build/lockfiles/minified/secrets/oversize/gitignored', async () => {
    const selected = await collect({ rootPath: root, recursive: true, maxFileSizeBytes: 500 });

    expect(selected).toEqual(
      [
        'CLAUDE.md',
        'README.md',
        'cmd/main.go',
        'config/settings.yaml',
        'notes.txt',
        'package.json',
        'src/app.ts',
        'src/util/helpers.py',
        // `.munin-notes/` only resembles a store name — it is real source.
        '.munin-notes/real.md',
      ].sort(),
    );

    // None of the junk leaked in.
    for (const junk of [
      'node_modules/dep/index.js',
      '.git/config',
      'dist/bundle.js',
      'src/vendor/lib.js',
      '.claude/worktrees/copy/foo.ts',
      '.claude/settings.json',
      // Munin's own encrypted local-store dirs, suffix + default-home variants.
      '.munin-local.openai-run/blobs/ab/cd.md',
      '.munin/pgdata/base/relation.md',
      '.munin/blobs/ef/gh.md',
      'pnpm-lock.yaml',
      'app.min.js',
      'bundle.js.map',
      '.env',
      'terraform.tfvars',
      'server.pem',
      'logo.png',
      'big.ts',
      'generated-client.ts',
      'scratch/throwaway.ts',
      'alias.ts',
    ]) {
      expect(selected).not.toContain(junk);
    }
  });

  it('skips symlinks (no cycle, no escape-the-root) and completes the walk', async () => {
    // The `selfloop` directory symlink back to root would hang a naive walk.
    const selected = await collect({ rootPath: root, recursive: true, maxFileSizeBytes: 500 });
    expect(selected).not.toContain('alias.ts'); // symlinked source file
    expect(selected.some((p) => p.startsWith('selfloop/'))).toBe(false);
  });

  it('does not descend into .claude tooling state, but walks a real sibling', async () => {
    const selected = await collect({ rootPath: root, recursive: true, maxFileSizeBytes: 500 });
    // The worktree copy (and everything under .claude/) is never walked: pruning
    // the directory basename stops the descent before any hashing happens.
    expect(selected.some((p) => p.startsWith('.claude/'))).toBe(false);
    expect(selected).not.toContain('.claude/worktrees/copy/foo.ts');
    // A real source file sitting alongside .claude is still picked up.
    expect(selected).toContain('src/app.ts');
    // Repo-root CLAUDE.md is a file, not the `.claude` directory — still walked.
    expect(selected).toContain('CLAUDE.md');
  });

  it("does not walk Munin's own local-store dirs, but walks a real sibling", async () => {
    const selected = await collect({ rootPath: root, recursive: true, maxFileSizeBytes: 500 });
    // Encrypted blob/pgdata files inside a Munin store are never reached — the
    // directory is pruned before any file is hashed (the dotted-suffix dev
    // store and the default `.munin` home both).
    expect(selected.some((p) => p.startsWith('.munin-local.openai-run/'))).toBe(false);
    expect(selected.some((p) => p.startsWith('.munin/'))).toBe(false);
    expect(selected).not.toContain('.munin-local.openai-run/blobs/ab/cd.md');
    expect(selected).not.toContain('.munin/blobs/ef/gh.md');
    // A real doc dir whose name only RESEMBLES a store (`.munin-notes`) is walked.
    expect(selected).toContain('.munin-notes/real.md');
  });

  it('preserves the relative path as externalId and title for provenance', async () => {
    const records: ConnectorRecord[] = [];
    for await (const rec of filesystemConnector.list(
      { rootPath: root, recursive: true, maxFileSizeBytes: 500 },
      CTX,
    ) as AsyncIterable<ConnectorRecord>) {
      records.push(rec);
    }
    const appTs = records.find(
      (r) => r.kind === 'document' && r.document.externalId === 'src/app.ts',
    );
    expect(appTs).toBeDefined();
    if (appTs?.kind === 'document') {
      expect(appTs.document.title).toBe('src/app.ts');
      expect(appTs.document.externalId).toBe('src/app.ts');
    }
  });

  it('honours an explicit allowlist (only the named extensions)', async () => {
    const selected = await collect({
      rootPath: root,
      recursive: true,
      allowedExtensions: ['.go'],
      maxFileSizeBytes: 500,
    });
    expect(selected).toEqual(['cmd/main.go']);
  });

  it('can be told to ignore .gitignore', async () => {
    const selected = await collect({
      rootPath: root,
      recursive: true,
      respectGitignore: false,
      maxFileSizeBytes: 500,
    });
    // The gitignored files reappear; hard-ignored dirs (node_modules) stay out.
    expect(selected).toContain('generated-client.ts');
    expect(selected).toContain('scratch/throwaway.ts');
    expect(selected).not.toContain('node_modules/dep/index.js');
  });

  it('does not recurse when recursive is false', async () => {
    const selected = await collect({ rootPath: root, recursive: false, maxFileSizeBytes: 500 });
    // Only root-level allowed files; nothing from src/, cmd/, config/.
    expect(selected).toEqual(['CLAUDE.md', 'README.md', 'notes.txt', 'package.json'].sort());
  });
});

describe('filesystemConnector — nested .gitignore over the real walk', () => {
  let nested: string;

  beforeAll(async () => {
    nested = await mkdtemp(path.join(os.tmpdir(), 'munin-fs-gi-'));
    const w = async (rel: string, content: string): Promise<void> => {
      const abs = path.join(nested, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    };
    await w('.gitignore', '*.gen.ts\n');
    await w('top.gen.ts', 'export const a = 1;\n'); // ignored by root rule
    await w('pkg/.gitignore', '!keep.gen.ts\n'); // deeper negation re-includes
    await w('pkg/keep.gen.ts', 'export const b = 2;\n');
    await w('pkg/drop.gen.ts', 'export const c = 3;\n'); // still ignored
    await w('pkg/real.ts', 'export const d = 4;\n');
  });

  afterAll(async () => {
    if (nested) await rm(nested, { recursive: true, force: true });
  });

  it('lets a deeper .gitignore negation re-include a root-ignored file', async () => {
    const selected = await collect({ rootPath: nested, recursive: true });
    expect(selected).toEqual(['pkg/keep.gen.ts', 'pkg/real.ts'].sort());
  });
});
