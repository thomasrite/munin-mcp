// Unit tests for the local:init pure functions — template rendering, .env
// parsing, and the existing-.env assessment/refusal logic. No I/O, no store.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAuditEnabled } from '@muninhq/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG_PACKAGE,
  assessExistingEnv,
  buildNextSteps,
  formatRefusalReport,
  parseEnvFile,
  renderStarterEnv,
  writeSecretEnvFile,
} from './local-init';

const DATA_DIR = path.resolve('/tmp/munin-test/.munin-local');
const PG = path.join(DATA_DIR, 'pgdata');
const BLOBS = path.join(DATA_DIR, 'blobs');
const KEY = Buffer.alloc(32, 7).toString('base64');
const TENANT = '6f1f1e9c-1111-4222-8333-444455556666';
const ASSESS = { pgliteDataDir: PG, blobFsRoot: BLOBS, baseDir: path.dirname(PG) };

function starter(): string {
  return renderStarterEnv({
    pgliteDataDir: PG,
    blobFsRoot: BLOBS,
    encryptionKey: KEY,
    tenantId: TENANT,
  });
}

describe('renderStarterEnv', () => {
  it('renders the fully-local posture with every required key', () => {
    const env = starter();
    const vars = parseEnvFile(env);
    expect(vars.get('GRAPH_STORE')).toBe('local');
    expect(vars.get('JOBS')).toBe('inline');
    expect(vars.get('MUNIN_LOCAL_MODE')).toBe('true');
    expect(vars.get('LLM_PROVIDER')).toBe('ollama');
    expect(vars.get('EMBEDDING_PROVIDER')).toBe('ollama');
    expect(vars.get('OLLAMA_EMBEDDING_MODEL')).toBe('bge-m3');
    expect(vars.get('BLOB_STORAGE_IMPL')).toBe('filesystem');
    expect(vars.get('PGLITE_DATA_DIR')).toBe(PG);
    expect(vars.get('BLOB_STORAGE_FS_ROOT')).toBe(BLOBS);
    expect(vars.get('MUNIN_BLOB_ENCRYPTION_KEY')).toBe(KEY);
    expect(vars.get('EXTRACTION_CONFIG_PACKAGE')).toBe(DEFAULT_CONFIG_PACKAGE);
    expect(vars.get('MUNIN_CONFIG_PACKAGE')).toBe(DEFAULT_CONFIG_PACKAGE);
    expect(vars.get('MUNIN_TENANT_ID')).toBe(TENANT);
    // ANSWER_MODEL must equal OLLAMA_MODEL in local mode.
    expect(vars.get('ANSWER_MODEL')).toBe(vars.get('OLLAMA_MODEL'));
  });

  it('keeps the cloud-key alternative commented out, with the honesty note', () => {
    const env = starter();
    const vars = parseEnvFile(env);
    // Present only as comments — must not take effect.
    expect(vars.has('MUNIN_ALLOW_CLOUD_PROVIDERS')).toBe(false);
    expect(vars.has('ANTHROPIC_API_KEY')).toBe(false);
    expect(env).toContain('# MUNIN_ALLOW_CLOUD_PROVIDERS=true');
    expect(env.toLowerCase()).toContain('your machine, your keys, your choice of provider');
  });

  it('makes no residency claims', () => {
    expect(starter().toLowerCase()).not.toMatch(/\buk\b|residency/);
  });

  it('turns the per-read audit OFF so the local read path never writes', () => {
    const env = starter();
    const vars = parseEnvFile(env);
    expect(vars.get('MUNIN_READ_AUDIT')).toBe('false');
    // End-to-end with the engine gate: this env disables the AuditedGraphStore
    // decorator, so loadGraphStore serves reads through the raw, non-writing store.
    const asEnv = Object.fromEntries(vars) as NodeJS.ProcessEnv;
    expect(readAuditEnabled(asEnv)).toBe(false);
  });
});

describe('parseEnvFile', () => {
  it('skips comments and blanks, last assignment wins, strips quotes', () => {
    const vars = parseEnvFile('# c\n\nA=1\nA=2\nB="quoted"\nC=\'q2\'\nnoequals\n=novalue\n');
    expect(vars.get('A')).toBe('2');
    expect(vars.get('B')).toBe('quoted');
    expect(vars.get('C')).toBe('q2');
    expect(vars.size).toBe(3);
  });
});

describe('assessExistingEnv', () => {
  it('round-trips the rendered starter as a complete setup', () => {
    const a = assessExistingEnv(starter(), ASSESS);
    expect(a.ok).toBe(true);
    expect(a.missing).toEqual([]);
    expect(a.conflicts).toEqual([]);
    expect(a.tenantId).toBe(TENANT);
    expect(a.configPackage).toBe(DEFAULT_CONFIG_PACKAGE);
  });

  it('preserves the encryption key byte-for-byte', () => {
    const a = assessExistingEnv(starter(), ASSESS);
    expect(a.encryptionKey).toBe(KEY);
  });

  it('reports missing keys as expected lines', () => {
    const a = assessExistingEnv('DATABASE_URL=postgres://x\n', ASSESS);
    expect(a.ok).toBe(false);
    expect(a.missing.some((m) => m.startsWith('GRAPH_STORE=local'))).toBe(true);
    expect(a.missing.some((m) => m.startsWith('JOBS=inline'))).toBe(true);
    expect(a.missing.some((m) => m.startsWith('MUNIN_BLOB_ENCRYPTION_KEY='))).toBe(true);
    expect(a.missing.some((m) => m.startsWith('MUNIN_TENANT_ID='))).toBe(true);
  });

  it('reports conflicting values with the current value', () => {
    const content = starter().replace('GRAPH_STORE=local', 'GRAPH_STORE=postgres');
    const a = assessExistingEnv(content, ASSESS);
    expect(a.ok).toBe(false);
    expect(a.conflicts).toContainEqual({
      key: 'GRAPH_STORE',
      expected: 'local',
      actual: 'postgres',
    });
  });

  it('accepts MUNIN_ALLOW_CLOUD_PROVIDERS=true as a declared posture', () => {
    const content = starter()
      .replace('MUNIN_LOCAL_MODE=true', 'MUNIN_ALLOW_CLOUD_PROVIDERS=true')
      .replace('LLM_PROVIDER=ollama', 'LLM_PROVIDER=anthropic');
    const a = assessExistingEnv(content, ASSESS);
    expect(a.ok).toBe(true);
  });

  it('flags an undeclared posture', () => {
    const content = starter().replace('MUNIN_LOCAL_MODE=true', 'MUNIN_LOCAL_MODE=false');
    const a = assessExistingEnv(content, ASSESS);
    expect(a.ok).toBe(false);
    expect(a.conflicts.some((c) => c.key === 'MUNIN_LOCAL_MODE')).toBe(true);
  });

  it('treats path values as equal when they resolve to the same place', () => {
    const rel = path.relative(path.dirname(PG), PG);
    const content = starter().replace(`PGLITE_DATA_DIR=${PG}`, `PGLITE_DATA_DIR=./${rel}`);
    const a = assessExistingEnv(content, ASSESS);
    expect(a.ok).toBe(true);
  });

  it('flags a data dir pointing somewhere else', () => {
    const content = starter().replace(`PGLITE_DATA_DIR=${PG}`, 'PGLITE_DATA_DIR=/elsewhere/pg');
    const a = assessExistingEnv(content, ASSESS);
    expect(a.ok).toBe(false);
    expect(a.conflicts.some((c) => c.key === 'PGLITE_DATA_DIR')).toBe(true);
  });

  it('flags an encryption key of the wrong length', () => {
    const content = starter().replace(KEY, Buffer.alloc(16, 1).toString('base64'));
    const a = assessExistingEnv(content, ASSESS);
    expect(a.ok).toBe(false);
    expect(
      a.conflicts.some(
        (c) => c.key === 'MUNIN_BLOB_ENCRYPTION_KEY' && c.actual.includes('16 bytes'),
      ),
    ).toBe(true);
  });
});

describe('formatRefusalReport', () => {
  it('lists every missing and conflicting line, diff-style', () => {
    const content = 'GRAPH_STORE=postgres\n';
    const a = assessExistingEnv(content, ASSESS);
    const report = formatRefusalReport('/repo/.env', a).join('\n');
    expect(report).toContain('never edits an existing .env');
    expect(report).toContain('~ GRAPH_STORE=local    (currently: postgres)');
    expect(report).toContain('+ JOBS=inline    (missing)');
  });
});

describe('buildNextSteps', () => {
  it('prints the exact commands and routes MCP connection through the portable home flow', () => {
    const steps = buildNextSteps({
      tenantId: TENANT,
      repoRoot: '/repo',
      configPackage: DEFAULT_CONFIG_PACKAGE,
    });
    expect(steps).toContain('ollama pull bge-m3');
    expect(steps).toContain(`ingest /path/to/your/docs --tenant ${TENANT} --tags personal`);
    expect(steps).toContain(`extract --tenant ${TENANT}`);
    // The launcher reads MUNIN_HOME, not the repo .env: connection goes through
    // `munin init` + `munin mcp connect` (no hand-edited client JSON here).
    expect(steps).toContain('munin init');
    expect(steps).toContain('munin mcp connect --client claude-desktop --write');
    expect(steps).toContain('munin mcp doctor');
    expect(steps).toContain('single-process');
  });
});

// The secret writer touches the filesystem; isolate it in a temp dir. It must
// refuse a symlink target so the AES blob key is never written through a
// pre-planted link (parity with set-key's writeEnvFileSecure).
describe('writeSecretEnvFile (symlink refusal + 0600)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-secret-writer-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a fresh env file at mode 0600', () => {
    const envPath = path.join(dir, 'munin.env');
    writeSecretEnvFile(envPath, 'MUNIN_TENANT_ID=abc\n');
    expect(fs.readFileSync(envPath, 'utf8')).toBe('MUNIN_TENANT_ID=abc\n');
    // Low 9 bits == 0o600 (owner rw only).
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('refuses a symlink whose target does NOT yet exist (the follow-the-link hole)', () => {
    const target = path.join(dir, 'evil-target.env'); // does not exist
    const envPath = path.join(dir, 'munin.env');
    fs.symlinkSync(target, envPath);
    expect(() => writeSecretEnvFile(envPath, 'MUNIN_BLOB_ENCRYPTION_KEY=secret\n')).toThrow(
      /symlink/,
    );
    // The secret must NOT have been written through the link.
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses a symlink pointing at an existing file (no overwrite through the link)', () => {
    const target = path.join(dir, 'real.env');
    fs.writeFileSync(target, 'PRE_EXISTING=1\n');
    const envPath = path.join(dir, 'munin.env');
    fs.symlinkSync(target, envPath);
    expect(() => writeSecretEnvFile(envPath, 'MUNIN_BLOB_ENCRYPTION_KEY=secret\n')).toThrow(
      /symlink/,
    );
    // The link target is untouched (the secret never reached it).
    expect(fs.readFileSync(target, 'utf8')).toBe('PRE_EXISTING=1\n');
  });
});
