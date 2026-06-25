import path from 'node:path';
import { readAuditEnabled } from '@muninhq/engine';
import { describe, expect, it } from 'vitest';

import { muninHomeLayout } from '@muninhq/shared';

import { assessHomeEnv, renderHomeStarterEnv } from './home-init';
import { parseEnvFile } from './local-init';

const HOME = '/Users/alice/.munin';
const LAYOUT = muninHomeLayout(HOME);
const KEY = Buffer.alloc(32).toString('base64');

function homeEnv(extra = ''): string {
  return `GRAPH_STORE=local
JOBS=inline
MUNIN_LOCAL_MODE=true
LLM_PROVIDER=ollama
EMBEDDING_PROVIDER=ollama
BLOB_STORAGE_IMPL=filesystem
MUNIN_BLOB_ENCRYPTION_KEY=${KEY}
EXTRACTION_CONFIG_PACKAGE=@muninhq/config-personal
MUNIN_CONFIG_PACKAGE=@muninhq/config-personal
MUNIN_TENANT_ID=00000000-0000-4000-8000-000000000001
${extra}`;
}

describe('assessHomeEnv (requireDataPaths: false)', () => {
  it('accepts a complete home env that OMITS the data-dir lines', () => {
    const result = assessHomeEnv(homeEnv(), LAYOUT);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.tenantId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('renderHomeStarterEnv output passes its own assessment', () => {
    const content = renderHomeStarterEnv({ encryptionKey: KEY, tenantId: 'abc' });
    expect(assessHomeEnv(content, LAYOUT).ok).toBe(true);
  });

  it('renderHomeStarterEnv turns the per-read audit OFF (non-writing local read path)', () => {
    const content = renderHomeStarterEnv({ encryptionKey: KEY, tenantId: 'abc' });
    const vars = parseEnvFile(content);
    expect(vars.get('MUNIN_READ_AUDIT')).toBe('false');
    // The engine gate agrees: this env serves reads through the raw, non-writing store.
    expect(readAuditEnabled(Object.fromEntries(vars) as NodeJS.ProcessEnv)).toBe(false);
  });

  it('still refuses when the posture is undeclared', () => {
    const content = homeEnv().replace('MUNIN_LOCAL_MODE=true\n', '');
    const result = assessHomeEnv(content, LAYOUT);
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.includes('MUNIN_LOCAL_MODE'))).toBe(true);
  });

  it('accepts a PRESENT data path that matches the derived layout (escape hatch)', () => {
    const result = assessHomeEnv(homeEnv(`PGLITE_DATA_DIR=${LAYOUT.pgliteDataDir}`), LAYOUT);
    expect(result.ok).toBe(true);
  });

  it('REJECTS a present-but-mismatched data path (escape hatch must match)', () => {
    const result = assessHomeEnv(homeEnv(`PGLITE_DATA_DIR=${path.join(HOME, 'wrong')}`), LAYOUT);
    expect(result.ok).toBe(false);
    expect(result.conflicts.some((c) => c.key === 'PGLITE_DATA_DIR')).toBe(true);
  });

  it('flags an invalid encryption key length', () => {
    const content = homeEnv().replace(KEY, 'too-short');
    const result = assessHomeEnv(content, LAYOUT);
    expect(result.ok).toBe(false);
    expect(result.conflicts.some((c) => c.key === 'MUNIN_BLOB_ENCRYPTION_KEY')).toBe(true);
  });
});
