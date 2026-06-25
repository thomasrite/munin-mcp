import { describe, expect, it } from 'vitest';

import {
  globToRegExp,
  hasAllowedExtension,
  isIgnoredDirName,
  isIgnoredFileName,
} from './ignore-rules';

describe('isIgnoredDirName', () => {
  it('ignores dependency/build/VCS directories by default', () => {
    for (const d of ['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv']) {
      expect(isIgnoredDirName(d)).toBe(true);
    }
  });

  it('ignores Claude Code tooling state (.claude, holding worktree copies)', () => {
    expect(isIgnoredDirName('.claude')).toBe(true);
  });

  it('does not ignore ordinary source directories', () => {
    for (const d of ['src', 'lib', 'packages', 'app', 'components']) {
      expect(isIgnoredDirName(d)).toBe(false);
    }
  });

  it('honours a caller-supplied ignore set', () => {
    const custom = new Set(['generated']);
    expect(isIgnoredDirName('generated', custom)).toBe(true);
    expect(isIgnoredDirName('node_modules', custom)).toBe(false);
  });

  it("ignores Munin's own local-store dirs (exact and dotted-suffix variants)", () => {
    for (const d of ['.munin', '.munin-local', '.munin-local.openai-run', '.munin-local.x']) {
      expect(isIgnoredDirName(d)).toBe(true);
    }
  });

  it('prunes the dotted-suffix store variant even under a custom ignore set', () => {
    // The Munin-store prefix is structural, not part of the configurable junk set.
    expect(isIgnoredDirName('.munin-local.openai-run', new Set(['generated']))).toBe(true);
  });

  it('does not over-match unrelated dirs that merely start with .munin', () => {
    for (const d of ['.munin-notes', '.muninrc', 'munin', 'munin-data', '.muninx']) {
      expect(isIgnoredDirName(d)).toBe(false);
    }
  });
});

describe('isIgnoredFileName', () => {
  it('ignores lockfiles', () => {
    for (const f of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'go.sum']) {
      expect(isIgnoredFileName(f)).toBe(true);
    }
  });

  it('ignores minified/generated bundles and sourcemaps', () => {
    for (const f of ['app.min.js', 'styles.min.css', 'main.bundle.js', 'index.js.map']) {
      expect(isIgnoredFileName(f)).toBe(true);
    }
  });

  it('ignores secret/env files and OS cruft', () => {
    for (const f of ['.env', '.env.local', '.env.production', '.DS_Store', 'app.log']) {
      expect(isIgnoredFileName(f)).toBe(true);
    }
  });

  it('ignores credential/key material even in allowlisted formats', () => {
    for (const f of [
      'server.pem',
      'private.key',
      'cert.p12',
      'store.jks',
      'id_rsa',
      'id_ed25519',
      '.npmrc',
      '.netrc',
      'terraform.tfvars',
      'prod.tfvars',
      'secrets.yaml',
      'secrets.yml',
      'credentials.json',
      'service-account.json',
    ]) {
      expect(isIgnoredFileName(f)).toBe(true);
    }
  });

  it('does not ignore ordinary source files (no over-broad secret match)', () => {
    for (const f of [
      'index.ts',
      'app.py',
      'main.go',
      'package.json',
      'README.md',
      // Modules that merely reference secrets/credentials are real source.
      'secret-manager.ts',
      'credentials-provider.go',
      'use-secrets.tsx',
      'config.yaml',
    ]) {
      expect(isIgnoredFileName(f)).toBe(false);
    }
  });
});

describe('hasAllowedExtension', () => {
  const allowed = new Set(['.ts', '.py', '.md']);

  it('matches allowed extensions case-insensitively', () => {
    expect(hasAllowedExtension('app.ts', allowed)).toBe(true);
    expect(hasAllowedExtension('App.TS', allowed)).toBe(true);
    expect(hasAllowedExtension('script.py', allowed)).toBe(true);
  });

  it('rejects non-allowed and extensionless files', () => {
    expect(hasAllowedExtension('photo.png', allowed)).toBe(false);
    expect(hasAllowedExtension('Makefile', allowed)).toBe(false);
    expect(hasAllowedExtension('Dockerfile', allowed)).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('matches a leading-dot glob only with a trailing segment', () => {
    const re = globToRegExp('.env.*');
    expect(re.test('.env.local')).toBe(true);
    expect(re.test('.env')).toBe(false);
  });

  it('matches a suffix glob and rejects the bare extension', () => {
    const re = globToRegExp('*.min.js');
    expect(re.test('a.min.js')).toBe(true);
    expect(re.test('a.js')).toBe(false);
  });

  it('does not let * cross a path separator', () => {
    const re = globToRegExp('*.map');
    expect(re.test('a/b.map')).toBe(false);
  });

  it('collapses runs of * (no adjacent unbounded quantifiers)', () => {
    const re = globToRegExp('a***b');
    expect(re.source).not.toMatch(/\[\^\/\]\*\[\^\/\]\*/); // not two in a row
    expect(re.test('axyzb')).toBe(true);
    expect(re.test('ab')).toBe(true);
  });
});
