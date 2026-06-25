import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MUNIN_HOME_DIRNAME,
  MUNIN_ENV_FILENAME,
  muninHomeLayout,
  resolveMuninHome,
  resolveMuninHomeLayout,
} from './munin-home';

describe('resolveMuninHome', () => {
  it('defaults to ~/.munin when MUNIN_HOME is unset', () => {
    const home = resolveMuninHome({} as NodeJS.ProcessEnv);
    expect(home).toBe(path.join(os.homedir(), DEFAULT_MUNIN_HOME_DIRNAME));
    expect(path.isAbsolute(home)).toBe(true);
  });

  it('uses MUNIN_HOME when set (absolute)', () => {
    const home = resolveMuninHome({ MUNIN_HOME: '/srv/munin-home' } as NodeJS.ProcessEnv);
    expect(home).toBe('/srv/munin-home');
  });

  it('resolves a relative MUNIN_HOME to an absolute path', () => {
    const home = resolveMuninHome({ MUNIN_HOME: 'rel/home' } as NodeJS.ProcessEnv);
    expect(path.isAbsolute(home)).toBe(true);
    expect(home).toBe(path.resolve('rel/home'));
  });

  it('treats an empty / whitespace MUNIN_HOME as unset', () => {
    expect(resolveMuninHome({ MUNIN_HOME: '   ' } as NodeJS.ProcessEnv)).toBe(
      path.join(os.homedir(), DEFAULT_MUNIN_HOME_DIRNAME),
    );
  });

  describe('process.env fallback', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('reads process.env by default', () => {
      vi.stubEnv('MUNIN_HOME', '/from/process/env');
      expect(resolveMuninHome()).toBe('/from/process/env');
    });
  });
});

describe('muninHomeLayout', () => {
  it('derives envPath, pgliteDataDir and blobFsRoot under the home', () => {
    const layout = muninHomeLayout('/Users/alice/.munin');
    expect(layout).toEqual({
      home: '/Users/alice/.munin',
      envPath: path.join('/Users/alice/.munin', MUNIN_ENV_FILENAME),
      pgliteDataDir: path.join('/Users/alice/.munin', 'pgdata'),
      blobFsRoot: path.join('/Users/alice/.munin', 'blobs'),
    });
  });

  it('uses munin.env (not .env) as the settings filename', () => {
    expect(MUNIN_ENV_FILENAME).toBe('munin.env');
    expect(muninHomeLayout('/x').envPath.endsWith('/munin.env')).toBe(true);
  });

  it('resolves a relative home to absolute before deriving', () => {
    const layout = muninHomeLayout('rel/home');
    expect(path.isAbsolute(layout.home)).toBe(true);
    expect(path.isAbsolute(layout.pgliteDataDir)).toBe(true);
    expect(path.isAbsolute(layout.blobFsRoot)).toBe(true);
    expect(layout.home).toBe(path.resolve('rel/home'));
  });

  it('data dirs are derived from the home, so a relocated home relocates them', () => {
    const a = muninHomeLayout('/homes/alice/.munin');
    const b = muninHomeLayout('/homes/bob/.munin');
    expect(a.pgliteDataDir).not.toBe(b.pgliteDataDir);
    expect(path.dirname(a.pgliteDataDir)).toBe(a.home);
    expect(path.dirname(b.blobFsRoot)).toBe(b.home);
  });
});

describe('resolveMuninHomeLayout', () => {
  it('combines resolution + layout', () => {
    const layout = resolveMuninHomeLayout({ MUNIN_HOME: '/srv/m' } as NodeJS.ProcessEnv);
    expect(layout.home).toBe('/srv/m');
    expect(layout.envPath).toBe(path.join('/srv/m', 'munin.env'));
  });
});
