// Unit tests for the read-audit-off back-fill migration: the pure content
// transform (adds when local + absent, never overrides) and the in-place file
// apply (0600, atomic, idempotent, symlink-refusing).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAuditEnabled } from '@muninhq/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEnvFile } from './local-init';
import {
  READ_AUDIT_KEY,
  applyLocalReadAuditMigration,
  migrateLocalReadAuditOff,
} from './read-audit-migration';

const LOCAL = 'GRAPH_STORE=local\nJOBS=inline\nMUNIN_LOCAL_MODE=true\n';

function asEnv(content: string): NodeJS.ProcessEnv {
  return Object.fromEntries(parseEnvFile(content)) as NodeJS.ProcessEnv;
}

describe('migrateLocalReadAuditOff (pure)', () => {
  it('adds MUNIN_READ_AUDIT=false to a local home that lacks it', () => {
    const r = migrateLocalReadAuditOff(LOCAL);
    expect(r.changed).toBe(true);
    expect(parseEnvFile(r.content).get(READ_AUDIT_KEY)).toBe('false');
    // The engine gate now reads it as OFF (the whole point).
    expect(readAuditEnabled(asEnv(r.content))).toBe(false);
  });

  it('is a no-op when MUNIN_READ_AUDIT=false is already present', () => {
    const r = migrateLocalReadAuditOff(`${LOCAL}MUNIN_READ_AUDIT=false\n`);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(`${LOCAL}MUNIN_READ_AUDIT=false\n`);
  });

  it('NEVER overrides an explicit MUNIN_READ_AUDIT=true (user re-enabled it)', () => {
    const input = `${LOCAL}MUNIN_READ_AUDIT=true\n`;
    const r = migrateLocalReadAuditOff(input);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(input);
    // And the engine still treats it as ON — the user's choice stands.
    expect(readAuditEnabled(asEnv(r.content))).toBe(true);
  });

  it('does not touch a non-local (hosted Postgres) env', () => {
    const r = migrateLocalReadAuditOff('GRAPH_STORE=postgres\nDATABASE_URL=postgres://x\n');
    expect(r.changed).toBe(false);
  });

  it('does not touch an env with no GRAPH_STORE at all', () => {
    const r = migrateLocalReadAuditOff('LLM_PROVIDER=ollama\n');
    expect(r.changed).toBe(false);
  });

  it('inserts a leading newline when the file has no trailing one', () => {
    const r = migrateLocalReadAuditOff('GRAPH_STORE=local');
    expect(r.changed).toBe(true);
    expect(r.content.startsWith('GRAPH_STORE=local\n')).toBe(true);
    expect(parseEnvFile(r.content).get(READ_AUDIT_KEY)).toBe('false');
  });
});

describe('applyLocalReadAuditMigration (in place)', () => {
  let dir: string;
  let envPath: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-ra-migrate-')));
    envPath = path.join(dir, 'munin.env');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('back-fills the line, returns true, and keeps the file at mode 0600', () => {
    fs.writeFileSync(envPath, LOCAL, { mode: 0o600 });
    const changed = applyLocalReadAuditMigration(envPath);
    expect(changed).toBe(true);
    const written = fs.readFileSync(envPath, 'utf8');
    expect(parseEnvFile(written).get(READ_AUDIT_KEY)).toBe('false');
    expect((fs.statSync(envPath).mode & 0o777).toString(8)).toBe('600');
  });

  it('is idempotent — a second run changes nothing', () => {
    fs.writeFileSync(envPath, LOCAL, { mode: 0o600 });
    expect(applyLocalReadAuditMigration(envPath)).toBe(true);
    const afterFirst = fs.readFileSync(envPath, 'utf8');
    expect(applyLocalReadAuditMigration(envPath)).toBe(false);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(afterFirst);
  });

  it('does not write a non-local env file', () => {
    fs.writeFileSync(envPath, 'GRAPH_STORE=postgres\n', { mode: 0o600 });
    const before = fs.statSync(envPath).mtimeMs;
    expect(applyLocalReadAuditMigration(envPath)).toBe(false);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('GRAPH_STORE=postgres\n');
    expect(fs.statSync(envPath).mtimeMs).toBe(before);
  });

  it('is a no-op (false) when the file does not exist', () => {
    expect(applyLocalReadAuditMigration(path.join(dir, 'absent.env'))).toBe(false);
  });

  it('refuses to write through a symlink', () => {
    const real = path.join(dir, 'real.env');
    fs.writeFileSync(real, LOCAL, { mode: 0o600 });
    const link = path.join(dir, 'link.env');
    fs.symlinkSync(real, link);
    expect(() => applyLocalReadAuditMigration(link)).toThrow(/symlink/);
    // The real file is untouched.
    expect(parseEnvFile(fs.readFileSync(real, 'utf8')).has(READ_AUDIT_KEY)).toBe(false);
  });
});
