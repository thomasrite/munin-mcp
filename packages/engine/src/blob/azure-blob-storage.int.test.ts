// Integration tests for AzureBlobStorage against Azurite via testcontainers.

import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asTenantId } from '../graph/types';
import { AzureBlobStorage } from './azure-blob-storage';
import { BlobNotFoundError } from './blob-storage';

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000a1');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000b2');

// Azurite well-known dev credentials. Not a secret.
const AZURITE_ACCOUNT = 'devstoreaccount1';
const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

let container: StartedTestContainer;
let endpoint: string;
let store: AzureBlobStorage;

beforeAll(async () => {
  container = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite:latest')
    .withExposedPorts(10000)
    .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck'])
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(10000);
  endpoint = `http://${host}:${port}/${AZURITE_ACCOUNT}`;
  store = new AzureBlobStorage({
    authMode: 'devkey',
    endpoint,
    accountName: AZURITE_ACCOUNT,
    accountKey: AZURITE_KEY,
    containerPrefix: 'munin-tenant-',
  });
}, 180_000);

afterAll(async () => {
  if (container) await container.stop();
});

describe('AzureBlobStorage against Azurite', () => {
  it('round-trips bytes through put and get', async () => {
    const payload = new TextEncoder().encode('hello, blob');
    const uri = await store.put(TENANT_A, 'documents/d1/test.txt', payload, {
      contentType: 'text/plain',
    });
    expect(uri).toMatch(/test\.txt$/);
    const fetched = await store.get(uri);
    expect(new TextDecoder().decode(fetched)).toBe('hello, blob');
  });

  it('exists returns true after put, false for missing blobs', async () => {
    const uri = await store.put(TENANT_A, 'documents/d2/x.bin', new Uint8Array([1, 2, 3]));
    expect(await store.exists(uri)).toBe(true);
    const missing = uri.replace('x.bin', 'no-such.bin');
    expect(await store.exists(missing)).toBe(false);
  });

  it('get throws BlobNotFoundError for missing blob', async () => {
    const fakeUri = `${endpoint}/munin-tenant-${TENANT_A}/documents/d99/missing.bin`;
    await expect(store.get(fakeUri)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('uses a separate container per tenant', async () => {
    const a = await store.put(TENANT_A, 'documents/d3/file', new Uint8Array([1]));
    const b = await store.put(TENANT_B, 'documents/d3/file', new Uint8Array([2]));
    expect(a).not.toBe(b);
    expect(new Uint8Array(await store.get(a))[0]).toBe(1);
    expect(new Uint8Array(await store.get(b))[0]).toBe(2);
  });

  it('ensureTenantContainer is idempotent', async () => {
    await store.ensureTenantContainer(TENANT_A);
    await store.ensureTenantContainer(TENANT_A);
    // no exception = pass
  });

  it('delete removes the blob (exists becomes false) and is idempotent', async () => {
    const uri = await store.put(TENANT_A, 'documents/erase/d.txt', new TextEncoder().encode('pii'));
    expect(await store.exists(uri)).toBe(true);
    await store.delete(uri);
    expect(await store.exists(uri)).toBe(false);
    // A repeat delete (erasure retry) on an already-gone blob is success.
    await expect(store.delete(uri)).resolves.toBeUndefined();
  });
});
