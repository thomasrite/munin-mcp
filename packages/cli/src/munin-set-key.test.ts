// `munin set-key` (S2 deliverable 5): the env it writes, the in-place upsert,
// key REDACTION (never echoed), and the 0600 file mode. File-I/O only — no DB.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { muninHomeLayout } from '@muninhq/shared';

import { assessHomeEnv } from './home-init';
import { renderHomeStarterEnv } from './home-init';
import { parseEnvFile } from './local-init';
import {
  ANTHROPIC_MODEL,
  OPENAI_MODEL,
  type SetKeyResult,
  formatSetKeySummary,
  planProviderEnv,
  runSetKey,
  upsertEnvVars,
} from './munin-set-key';

describe('planProviderEnv', () => {
  it('anthropic: Claude LLM + models, embeddings stay local, posture flipped', () => {
    const p = planProviderEnv('anthropic');
    expect(p.keyVar).toBe('ANTHROPIC_API_KEY');
    expect(p.llmProvider).toBe('anthropic');
    expect(p.embeddingProvider).toBe('ollama');
    expect(p.envUpdates).toMatchObject({
      LLM_PROVIDER: 'anthropic',
      EMBEDDING_PROVIDER: 'ollama',
      EXTRACTION_MODEL: ANTHROPIC_MODEL,
      ANSWER_MODEL: ANTHROPIC_MODEL,
      GENERATION_MODEL: ANTHROPIC_MODEL,
      MUNIN_LOCAL_MODE: 'false',
      MUNIN_ALLOW_CLOUD_PROVIDERS: 'true',
    });
    // The key var is NOT part of the non-secret plan.
    expect(p.envUpdates).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('openai: GPT LLM + models AND OpenAI cloud embeddings, posture flipped', () => {
    const p = planProviderEnv('openai');
    expect(p.keyVar).toBe('OPENAI_API_KEY');
    expect(p.llmProvider).toBe('openai');
    expect(p.embeddingProvider).toBe('openai');
    expect(p.envUpdates).toMatchObject({
      LLM_PROVIDER: 'openai',
      EMBEDDING_PROVIDER: 'openai',
      EXTRACTION_MODEL: OPENAI_MODEL,
      MUNIN_LOCAL_MODE: 'false',
      MUNIN_ALLOW_CLOUD_PROVIDERS: 'true',
    });
  });
});

describe('upsertEnvVars', () => {
  it('rewrites an existing uncommented assignment in place', () => {
    const out = upsertEnvVars('A=1\nMUNIN_LOCAL_MODE=true\nB=2\n', { MUNIN_LOCAL_MODE: 'false' });
    expect(out).toBe('A=1\nMUNIN_LOCAL_MODE=false\nB=2\n');
  });

  it('appends a missing key in a labelled block', () => {
    const out = upsertEnvVars('A=1\n', { MUNIN_ALLOW_CLOUD_PROVIDERS: 'true' });
    expect(out).toContain('# --- Cloud provider (added by `munin set-key`) ---');
    expect(out).toContain('MUNIN_ALLOW_CLOUD_PROVIDERS=true');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('leaves commented example lines untouched (and adds a real assignment)', () => {
    const out = upsertEnvVars('# MUNIN_ALLOW_CLOUD_PROVIDERS=true\nA=1\n', {
      MUNIN_ALLOW_CLOUD_PROVIDERS: 'true',
    });
    // The comment is preserved verbatim...
    expect(out).toContain('# MUNIN_ALLOW_CLOUD_PROVIDERS=true');
    // ...and a real, uncommented assignment is appended.
    expect(out).toMatch(/^MUNIN_ALLOW_CLOUD_PROVIDERS=true$/m);
  });

  it('drops a duplicate uncommented assignment of a managed key', () => {
    const out = upsertEnvVars('LLM_PROVIDER=ollama\nX=1\nLLM_PROVIDER=stub\n', {
      LLM_PROVIDER: 'anthropic',
    });
    expect(out).toBe('LLM_PROVIDER=anthropic\nX=1\n');
  });

  it('preserves unrelated lines including a secret already present', () => {
    const out = upsertEnvVars('MUNIN_BLOB_ENCRYPTION_KEY=abc\nLLM_PROVIDER=ollama\n', {
      LLM_PROVIDER: 'openai',
    });
    expect(out).toContain('MUNIN_BLOB_ENCRYPTION_KEY=abc');
    expect(out).toContain('LLM_PROVIDER=openai');
  });
});

describe('runSetKey', () => {
  const KEY = Buffer.alloc(32).toString('base64');
  const SECRET = 'sk-ant-SECRET-do-not-print-1234567890';
  let home: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-setkey-')));
    const layout = muninHomeLayout(home);
    fs.writeFileSync(
      layout.envPath,
      renderHomeStarterEnv({ encryptionKey: KEY, tenantId: 'tenant-1' }),
      { mode: 0o600 },
    );
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('anthropic: writes the key + posture, keeps local embeddings, no re-embed', async () => {
    const result = await runSetKey({
      home,
      provider: 'anthropic',
      key: SECRET,
      stamp: () => 'STAMP',
    });
    const written = fs.readFileSync(muninHomeLayout(home).envPath, 'utf8');
    // The secret IS in the file (it is the secret store)...
    expect(written).toContain(`ANTHROPIC_API_KEY=${SECRET}`);
    expect(written).toContain('LLM_PROVIDER=anthropic');
    expect(written).toContain('MUNIN_LOCAL_MODE=false');
    expect(written).toContain('MUNIN_ALLOW_CLOUD_PROVIDERS=true');
    expect(written).toContain(`ANSWER_MODEL=${ANTHROPIC_MODEL}`);
    expect(result.reEmbedNeeded).toBe(false); // ollama → ollama
    // ...but NEVER in the returned result or the printed summary (redaction).
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(formatSetKeySummary(result)).not.toContain(SECRET);
    // The output that file remains init-valid (so `munin init` won't refuse it).
    expect(assessHomeEnv(written, muninHomeLayout(home)).ok).toBe(true);
  });

  it('openai: switches embeddings to cloud and flags a re-embed', async () => {
    const result = await runSetKey({ home, provider: 'openai', key: 'sk-openai-XYZ' });
    const written = fs.readFileSync(muninHomeLayout(home).envPath, 'utf8');
    expect(written).toContain('OPENAI_API_KEY=sk-openai-XYZ');
    expect(written).toContain('EMBEDDING_PROVIDER=openai');
    expect(result.reEmbedNeeded).toBe(true); // ollama → openai
    expect(formatSetKeySummary(result)).toMatch(/re-embed/i);
  });

  it('writes the env file at mode 0600 (the key must not be world/group readable)', async () => {
    await runSetKey({ home, provider: 'anthropic', key: SECRET, stamp: () => 'STAMP' });
    const mode = fs.statSync(muninHomeLayout(home).envPath).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('backs up the previous env before overwriting', async () => {
    const result = await runSetKey({
      home,
      provider: 'anthropic',
      key: SECRET,
      stamp: () => 'STAMP',
    });
    expect(fs.existsSync(result.backupPath)).toBe(true);
    // The backup holds the ORIGINAL (fully-local) content, not the new key.
    const backup = fs.readFileSync(result.backupPath, 'utf8');
    expect(backup).toContain('MUNIN_LOCAL_MODE=true');
    expect(backup).not.toContain(SECRET);
    // The backup is a copy of a secret file — it must also be 0600.
    expect((fs.statSync(result.backupPath).mode & 0o777).toString(8)).toBe('600');
  });

  it('preserves an explicit MUNIN_READ_AUDIT=true (does not override the user)', async () => {
    const layout = muninHomeLayout(home);
    // A home where the user deliberately re-enabled the audit trail.
    const content = fs
      .readFileSync(layout.envPath, 'utf8')
      .replace('MUNIN_READ_AUDIT=false', 'MUNIN_READ_AUDIT=true');
    fs.writeFileSync(layout.envPath, content, { mode: 0o600 });
    await runSetKey({ home, provider: 'anthropic', key: SECRET, stamp: () => 'STAMP' });
    // Effective value (last assignment wins) is still true — never overridden.
    expect(parseEnvFile(fs.readFileSync(layout.envPath, 'utf8')).get('MUNIN_READ_AUDIT')).toBe(
      'true',
    );
  });

  it('back-fills MUNIN_READ_AUDIT=false on an older home that lacks it', async () => {
    const layout = muninHomeLayout(home);
    // An older home, written before the read-audit-off posture existed: strip the
    // assignment line (the comment block, which parseEnvFile ignores, may remain).
    const old = fs.readFileSync(layout.envPath, 'utf8').replace(/^MUNIN_READ_AUDIT=.*\n/m, '');
    fs.writeFileSync(layout.envPath, old, { mode: 0o600 });
    expect(parseEnvFile(old).has('MUNIN_READ_AUDIT')).toBe(false);
    await runSetKey({ home, provider: 'openai', key: 'sk-openai-XYZ', stamp: () => 'STAMP' });
    expect(parseEnvFile(fs.readFileSync(layout.envPath, 'utf8')).get('MUNIN_READ_AUDIT')).toBe(
      'false',
    );
  });

  it('refuses when there is no munin.env (must run `munin init` first)', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-setkey-empty-')));
    try {
      await expect(runSetKey({ home: empty, provider: 'anthropic', key: SECRET })).rejects.toThrow(
        /munin init/,
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('rejects an empty key', async () => {
    await expect(runSetKey({ home, provider: 'anthropic', key: '   ' })).rejects.toThrow(/empty/);
  });
});

// A no-key SetKeyResult is enough to exercise the summary's redaction-by-design.
const SAMPLE: SetKeyResult = {
  envPath: '/home/.munin/munin.env',
  provider: 'anthropic',
  llmProvider: 'anthropic',
  embeddingProvider: 'ollama',
  model: ANTHROPIC_MODEL,
  keyVar: 'ANTHROPIC_API_KEY',
  reEmbedNeeded: false,
  backupPath: '/home/.munin/munin.env.munin-backup-STAMP',
};

describe('formatSetKeySummary', () => {
  it('states the posture, provider, models and backup — and notes 0600', () => {
    const out = formatSetKeySummary(SAMPLE);
    expect(out).toContain('MUNIN_ALLOW_CLOUD_PROVIDERS=true');
    expect(out).toContain('anthropic');
    expect(out).toContain(ANTHROPIC_MODEL);
    expect(out).toContain('mode 0600');
    // The next-step points at the real subcommand (`munin mcp doctor`), not the
    // non-existent `munin doctor`.
    expect(out).toContain('munin mcp doctor');
  });
});
