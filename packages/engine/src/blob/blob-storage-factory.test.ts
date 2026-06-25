import { describe, expect, it } from 'vitest';

import { BlobStorageError } from './blob-storage';
import { loadBlobStorageFromEnv } from './blob-storage-factory';

describe('blob-storage-factory', () => {
  it('refuses devkey in production builds', () => {
    expect(() =>
      loadBlobStorageFromEnv({
        BLOB_STORAGE_AUTH_MODE: 'devkey',
        BLOB_STORAGE_ENDPOINT: 'http://x',
        BLOB_STORAGE_ACCOUNT_NAME: 'a',
        BLOB_STORAGE_ACCOUNT_KEY: 'k',
        NODE_ENV: 'production',
      }),
    ).toThrow(/devkey is refused/);
  });

  it('accepts devkey in non-production builds', () => {
    const store = loadBlobStorageFromEnv({
      BLOB_STORAGE_AUTH_MODE: 'devkey',
      BLOB_STORAGE_ENDPOINT: 'http://localhost:10000/devstoreaccount1',
      BLOB_STORAGE_ACCOUNT_NAME: 'devstoreaccount1',
      BLOB_STORAGE_ACCOUNT_KEY:
        'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
      NODE_ENV: 'development',
    });
    expect(store).toBeDefined();
  });

  it('refuses unknown auth modes', () => {
    expect(() =>
      loadBlobStorageFromEnv({
        BLOB_STORAGE_AUTH_MODE: 'gibberish',
      }),
    ).toThrow(BlobStorageError);
  });

  it('managed-identity constructs in production with an endpoint (G3 rig path)', () => {
    // DefaultAzureCredential resolves lazily — construction is offline, so
    // this is unit-safe. No key material appears anywhere in the config.
    const storage = loadBlobStorageFromEnv({
      BLOB_STORAGE_AUTH_MODE: 'managed-identity',
      BLOB_STORAGE_ENDPOINT: 'https://muninpilotsa.blob.core.windows.net',
      NODE_ENV: 'production',
    });
    expect(storage).toBeDefined();
  });

  it('managed-identity without an endpoint fails fast (cannot name the account)', () => {
    expect(() =>
      loadBlobStorageFromEnv({
        BLOB_STORAGE_AUTH_MODE: 'managed-identity',
        NODE_ENV: 'production',
      }),
    ).toThrow(/managed-identity auth requires endpoint/);
  });
  // --- MUNIN_LOCAL_MODE refuses the Azure backend (P1-1 blob leg, G1) -------

  it('local mode REFUSES an explicit azure backend (off-machine document bytes)', () => {
    expect(() =>
      loadBlobStorageFromEnv({ BLOB_STORAGE_IMPL: 'azure', MUNIN_LOCAL_MODE: 'true' }),
    ).toThrow(/MUNIN_LOCAL_MODE=true forbids the 'azure' blob backend/);
  });

  it('local mode REFUSES the SILENT azure default (BLOB_STORAGE_IMPL unset) and says so', () => {
    expect(() => loadBlobStorageFromEnv({ MUNIN_LOCAL_MODE: 'true' })).toThrow(
      /silent default — BLOB_STORAGE_IMPL was unset/,
    );
  });

  it('local mode still constructs the filesystem backend (with the mandatory key)', () => {
    const store = loadBlobStorageFromEnv({
      BLOB_STORAGE_IMPL: 'filesystem',
      MUNIN_LOCAL_MODE: 'true',
      MUNIN_BLOB_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    expect(store).toBeDefined();
  });
});
