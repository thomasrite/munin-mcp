import { describe, expect, it } from 'vitest';

import {
  appendIngestDefaults,
  flagValue,
  hasFlag,
  resolveSetKeyInput,
  stripFlag,
} from './munin-cli';

describe('flagValue', () => {
  it('returns the value following a flag', () => {
    expect(flagValue(['--home', '/srv/m', 'rest'], '--home')).toBe('/srv/m');
  });

  it('returns undefined when the flag is absent', () => {
    expect(flagValue(['ingest', 'docs'], '--home')).toBeUndefined();
  });

  it('returns undefined when the flag is last (no value to consume)', () => {
    expect(flagValue(['init', '--home'], '--home')).toBeUndefined();
  });

  it('never consumes a following flag as its value', () => {
    // `--home --tags x` must not name a home "--tags".
    expect(flagValue(['--home', '--tags', 'x'], '--home')).toBeUndefined();
  });
});

describe('hasFlag', () => {
  it('detects presence', () => {
    expect(hasFlag(['connect', '--write'], '--write')).toBe(true);
    expect(hasFlag(['connect'], '--write')).toBe(false);
  });
});

describe('stripFlag', () => {
  it('removes a value-bearing flag and its value', () => {
    expect(stripFlag(['docs', '--home', '/srv/m', '--tags', 'a'], '--home', true)).toEqual([
      'docs',
      '--tags',
      'a',
    ]);
  });

  it('removes a boolean flag without consuming the next token', () => {
    expect(stripFlag(['connect', '--write', '--client', 'cursor'], '--write', false)).toEqual([
      'connect',
      '--client',
      'cursor',
    ]);
  });

  it('is a no-op when the flag is absent', () => {
    expect(stripFlag(['docs', '--tags', 'a'], '--home', true)).toEqual(['docs', '--tags', 'a']);
  });
});

describe('resolveSetKeyInput', () => {
  it('accepts a POSITIONAL key after the provider (what a user naturally types)', () => {
    // `munin set-key openai sk-test` → cmdSetKey(['openai', 'sk-test'])
    expect(resolveSetKeyInput(['openai', 'sk-test'], {}, 'OPENAI_API_KEY')).toEqual({
      key: 'sk-test',
      source: 'positional',
    });
  });

  it('prefers --key over a positional key', () => {
    expect(
      resolveSetKeyInput(['openai', 'sk-positional', '--key', 'sk-flag'], {}, 'OPENAI_API_KEY'),
    ).toEqual({ key: 'sk-flag', source: 'flag' });
  });

  it('falls back to the provider env var (the recommended path) when nothing on the line', () => {
    expect(
      resolveSetKeyInput(['anthropic'], { ANTHROPIC_API_KEY: '  sk-env  ' }, 'ANTHROPIC_API_KEY'),
    ).toEqual({ key: 'sk-env', source: 'env' });
  });

  it('never mistakes a --home value for the positional key', () => {
    expect(resolveSetKeyInput(['openai', '--home', '/srv/m'], {}, 'OPENAI_API_KEY')).toEqual({
      key: undefined,
      source: 'none',
    });
    // ...but still finds a real positional key after the flag+value.
    expect(
      resolveSetKeyInput(['openai', '--home', '/srv/m', 'sk-test'], {}, 'OPENAI_API_KEY'),
    ).toEqual({ key: 'sk-test', source: 'positional' });
  });

  it('reports "none" when no key is given anywhere', () => {
    expect(resolveSetKeyInput(['openai'], {}, 'OPENAI_API_KEY')).toEqual({
      key: undefined,
      source: 'none',
    });
  });
});

describe('appendIngestDefaults', () => {
  it('adds --tenant from MUNIN_TENANT_ID and --tags personal when neither is present', () => {
    expect(appendIngestDefaults([], { MUNIN_TENANT_ID: 't-1' })).toEqual([
      '--tenant',
      't-1',
      '--tags',
      'personal',
    ]);
  });

  it('does not override a caller-supplied --tenant or --tags', () => {
    expect(
      appendIngestDefaults(['--tenant', 't-mine', '--tags', 'work'], { MUNIN_TENANT_ID: 't-env' }),
    ).toEqual(['--tenant', 't-mine', '--tags', 'work']);
  });

  it('respects the -t alias and still defaults the tags', () => {
    expect(appendIngestDefaults(['-t', 't-mine'], { MUNIN_TENANT_ID: 't-env' })).toEqual([
      '-t',
      't-mine',
      '--tags',
      'personal',
    ]);
  });

  it('omits --tenant when MUNIN_TENANT_ID is unset (ingest then reports it missing)', () => {
    expect(appendIngestDefaults([], {})).toEqual(['--tags', 'personal']);
  });
});
