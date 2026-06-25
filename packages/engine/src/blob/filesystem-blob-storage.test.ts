// Unit tests for the local/desktop filesystem BlobStorage (P1) and its factory
// selection + production guard. Pure local disk — no Docker, no network.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asTenantId } from '../graph/types';
import { AzureBlobStorage } from './azure-blob-storage';
import { BlobNotFoundError, BlobStorageError } from './blob-storage';
import { loadBlobStorageFromEnv } from './blob-storage-factory';
import { FilesystemBlobStorage } from './filesystem-blob-storage';

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000a1');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000b2');
// A deterministic base64 32-byte key for the factory encryption tests.
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'munin-blob-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FilesystemBlobStorage', () => {
  it('round-trips bytes EXACTLY (put -> get is byte-identical) and returns a file:// URI', async () => {
    const store = new FilesystemBlobStorage({ root });
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 128]);
    const uri = await store.put(TENANT_A, 'docs/a.bin', bytes);
    expect(uri.startsWith('file://')).toBe(true);
    const got = await store.get(uri);
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  it('isolates tenants by directory (same relativePath, different tenant => different file)', async () => {
    const store = new FilesystemBlobStorage({ root });
    const uriA = await store.put(TENANT_A, 'shared.txt', new TextEncoder().encode('A'));
    const uriB = await store.put(TENANT_B, 'shared.txt', new TextEncoder().encode('B'));
    expect(uriA).not.toBe(uriB);
    expect(new TextDecoder().decode(await store.get(uriA))).toBe('A');
    expect(new TextDecoder().decode(await store.get(uriB))).toBe('B');
    // each tenant's bytes live under its own tenant-id subdirectory
    expect(uriA).toContain(TENANT_A);
    expect(uriB).toContain(TENANT_B);
  });

  it('exists() reflects presence; get() of a missing blob throws BlobNotFoundError', async () => {
    const store = new FilesystemBlobStorage({ root });
    const uri = await store.put(TENANT_A, 'x.txt', new TextEncoder().encode('x'));
    expect(await store.exists(uri)).toBe(true);
    const missing = `file://${path.join(root, TENANT_A, 'nope.txt')}`;
    expect(await store.exists(missing)).toBe(false);
    await expect(store.get(missing)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('rejects path traversal that would escape the tenant container', async () => {
    const store = new FilesystemBlobStorage({ root });
    await expect(store.put(TENANT_A, '../escape.txt', new Uint8Array([1]))).rejects.toBeInstanceOf(
      BlobStorageError,
    );
    await expect(
      store.put(TENANT_A, '../../etc/whatever', new Uint8Array([1])),
    ).rejects.toBeInstanceOf(BlobStorageError);
  });

  it('refuses a get() URI that resolves outside the blob root', async () => {
    const store = new FilesystemBlobStorage({ root });
    await expect(store.get('file:///etc/passwd')).rejects.toBeInstanceOf(BlobStorageError);
  });

  it('ensureTenantContainer is idempotent', async () => {
    const store = new FilesystemBlobStorage({ root });
    await store.ensureTenantContainer(TENANT_A);
    await store.ensureTenantContainer(TENANT_A); // no throw on repeat
    const uri = await store.put(TENANT_A, 'y.txt', new TextEncoder().encode('y'));
    expect(await store.exists(uri)).toBe(true);
  });

  it('delete() removes the bytes (exists() becomes false; get() then throws)', async () => {
    const store = new FilesystemBlobStorage({ root });
    const uri = await store.put(TENANT_A, 'erase-me.txt', new TextEncoder().encode('pii'));
    expect(await store.exists(uri)).toBe(true);
    await store.delete(uri);
    expect(await store.exists(uri)).toBe(false);
    await expect(store.get(uri)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('delete() is IDEMPOTENT — deleting a missing blob is success (already gone == erased)', async () => {
    const store = new FilesystemBlobStorage({ root });
    const uri = await store.put(TENANT_A, 'gone.txt', new TextEncoder().encode('x'));
    await store.delete(uri);
    // A second delete (e.g. an erasure retry) must not throw.
    await expect(store.delete(uri)).resolves.toBeUndefined();
    // A never-existed blob is also a no-op success.
    const never = `file://${path.join(root, TENANT_A, 'never.txt')}`;
    await expect(store.delete(never)).resolves.toBeUndefined();
  });

  it('delete() refuses a URI that resolves outside the blob root (traversal guard)', async () => {
    const store = new FilesystemBlobStorage({ root });
    await expect(store.delete('file:///etc/passwd')).rejects.toBeInstanceOf(BlobStorageError);
  });

  it('delete() erases an at-rest-encrypted blob too (just unlinks; no decryption)', async () => {
    const KEY = new Uint8Array(Buffer.from(KEY_B64, 'base64'));
    const store = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const uri = await store.put(TENANT_A, 'enc-erase.txt', new TextEncoder().encode('secret'));
    expect(await store.exists(uri)).toBe(true);
    await store.delete(uri);
    expect(await store.exists(uri)).toBe(false);
  });
});

describe('loadBlobStorageFromEnv — filesystem selection + prod guard', () => {
  it('selects FilesystemBlobStorage for BLOB_STORAGE_IMPL=filesystem', () => {
    const store = loadBlobStorageFromEnv({
      BLOB_STORAGE_IMPL: 'filesystem',
      BLOB_STORAGE_FS_ROOT: root,
      NODE_ENV: 'development',
    });
    expect(store).toBeInstanceOf(FilesystemBlobStorage);
  });

  it('defaults to azure (NOT filesystem) when BLOB_STORAGE_IMPL is unset', () => {
    const store = loadBlobStorageFromEnv({
      NODE_ENV: 'development',
      // Azurite well-known dev endpoint/account/key so the azure devkey branch
      // constructs; the point is the DEFAULT selects azure, not filesystem.
      BLOB_STORAGE_ENDPOINT: 'http://127.0.0.1:10000/devstoreaccount1',
      BLOB_STORAGE_ACCOUNT_NAME: 'devstoreaccount1',
      BLOB_STORAGE_ACCOUNT_KEY:
        'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
    });
    expect(store).toBeInstanceOf(AzureBlobStorage);
    expect(store).not.toBeInstanceOf(FilesystemBlobStorage);
  });

  it('REFUSES filesystem under NODE_ENV=production without the local-mode opt-in', () => {
    expect(() =>
      loadBlobStorageFromEnv({
        BLOB_STORAGE_IMPL: 'filesystem',
        BLOB_STORAGE_FS_ROOT: root,
        NODE_ENV: 'production',
      }),
    ).toThrow(BlobStorageError);
  });

  it('ALLOWS filesystem under production when MUNIN_LOCAL_MODE=true (packaged desktop build)', () => {
    const store = loadBlobStorageFromEnv({
      BLOB_STORAGE_IMPL: 'filesystem',
      BLOB_STORAGE_FS_ROOT: root,
      NODE_ENV: 'production',
      MUNIN_LOCAL_MODE: 'true',
      // Local mode mandates at-rest encryption — supply the key (P2).
      MUNIN_BLOB_ENCRYPTION_KEY: KEY_B64,
    });
    expect(store).toBeInstanceOf(FilesystemBlobStorage);
  });

  it('throws on an unknown BLOB_STORAGE_IMPL', () => {
    expect(() => loadBlobStorageFromEnv({ BLOB_STORAGE_IMPL: 'gcs' })).toThrow(BlobStorageError);
  });
});

describe('FilesystemBlobStorage — AES-256-GCM at-rest encryption (P2)', () => {
  // The same key the factory tests use, decoded from base64 (so the two stay in
  // lockstep). Tests don't need a CSPRNG key.
  const KEY = new Uint8Array(Buffer.from(KEY_B64, 'base64'));

  it('round-trips bytes EXACTLY through encryption (put -> get is byte-identical)', async () => {
    const store = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 128, 42]);
    const uri = await store.put(TENANT_A, 'docs/secret.bin', bytes);
    const got = await store.get(uri);
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  it('round-trips an EMPTY blob (the exact IV+authTag boundary, length 28)', async () => {
    const store = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const uri = await store.put(TENANT_A, 'empty.bin', new Uint8Array(0));
    // On disk: iv (12) + 0 ciphertext + authTag (16) = exactly 28 bytes.
    expect((await readFile(fileURLToPath(uri))).length).toBe(28);
    expect((await store.get(uri)).length).toBe(0);
  });

  it('writes CIPHERTEXT to disk — the on-disk bytes are NOT the plaintext', async () => {
    const store = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const plaintext = new TextEncoder().encode('grievance: the budget is ninety thousand pounds');
    const uri = await store.put(TENANT_A, 'confidential.txt', plaintext);
    const onDisk = await readFile(fileURLToPath(uri));
    // The raw file must not contain the plaintext anywhere, and must be longer
    // than the plaintext (iv + auth tag overhead).
    expect(onDisk.length).toBeGreaterThan(plaintext.length);
    expect(onDisk.includes(Buffer.from(plaintext))).toBe(false);
    expect(new TextDecoder().decode(onDisk)).not.toContain('ninety thousand pounds');
  });

  it('a fresh IV per put => identical plaintext yields DIFFERENT ciphertext on disk', async () => {
    const store = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const bytes = new TextEncoder().encode('same content');
    const uriA = await store.put(TENANT_A, 'a.txt', bytes);
    const uriB = await store.put(TENANT_A, 'b.txt', bytes);
    const diskA = await readFile(fileURLToPath(uriA));
    const diskB = await readFile(fileURLToPath(uriB));
    expect(diskA.equals(diskB)).toBe(false);
    // ...yet both decrypt back to the same plaintext.
    expect(new TextDecoder().decode(await store.get(uriA))).toBe('same content');
    expect(new TextDecoder().decode(await store.get(uriB))).toBe('same content');
  });

  it('TAMPERING is detected — a flipped byte makes get() throw (auth tag mismatch)', async () => {
    const store = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const uri = await store.put(TENANT_A, 'tamper.bin', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const abs = fileURLToPath(uri);
    const onDisk = await readFile(abs);
    // Flip a bit in the ciphertext region (after the 12-byte IV).
    onDisk[14] = onDisk[14]! ^ 0xff;
    await writeFile(abs, onDisk);
    await expect(store.get(uri)).rejects.toBeInstanceOf(BlobStorageError);
  });

  it('a truncated/too-short encrypted blob throws rather than returning garbage', async () => {
    const store = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const uri = await store.put(TENANT_A, 'short.bin', new Uint8Array([9]));
    const abs = fileURLToPath(uri);
    await writeFile(abs, Buffer.from([1, 2, 3])); // shorter than IV+authTag
    await expect(store.get(uri)).rejects.toBeInstanceOf(BlobStorageError);
  });

  it('rejects a key that is not 32 bytes at construction', () => {
    expect(() => new FilesystemBlobStorage({ root, encryptionKey: new Uint8Array(16) })).toThrow(
      BlobStorageError,
    );
  });

  it("a store WITHOUT a key cannot read another store's ciphertext as plaintext", async () => {
    const encrypted = new FilesystemBlobStorage({ root, encryptionKey: KEY });
    const plain = new FilesystemBlobStorage({ root });
    const bytes = new TextEncoder().encode('top secret');
    const uri = await encrypted.put(TENANT_A, 'x.txt', bytes);
    // The plaintext store returns the raw ciphertext bytes, never 'top secret'.
    const raw = await plain.get(uri);
    expect(new TextDecoder().decode(raw)).not.toBe('top secret');
    // ...and the raw bytes carry the iv+authTag overhead, so they are not the
    // plaintext bytes either (length and content both differ).
    expect(raw.length).toBe(bytes.length + 12 + 16);
    expect(Buffer.from(raw).includes(Buffer.from(bytes))).toBe(false);
  });
});

describe('loadBlobStorageFromEnv — at-rest encryption key (P2)', () => {
  it('FAILS FAST when local + filesystem + no encryption key (never store plaintext)', () => {
    expect(() =>
      loadBlobStorageFromEnv({
        BLOB_STORAGE_IMPL: 'filesystem',
        BLOB_STORAGE_FS_ROOT: root,
        MUNIN_LOCAL_MODE: 'true',
      }),
    ).toThrow(BlobStorageError);
  });

  it('constructs an encrypting filesystem store when local + key supplied', () => {
    const store = loadBlobStorageFromEnv({
      BLOB_STORAGE_IMPL: 'filesystem',
      BLOB_STORAGE_FS_ROOT: root,
      MUNIN_LOCAL_MODE: 'true',
      MUNIN_BLOB_ENCRYPTION_KEY: KEY_B64,
    });
    expect(store).toBeInstanceOf(FilesystemBlobStorage);
  });

  it('rejects a malformed (wrong-length) MUNIN_BLOB_ENCRYPTION_KEY rather than degrading to plaintext', () => {
    expect(() =>
      loadBlobStorageFromEnv({
        BLOB_STORAGE_IMPL: 'filesystem',
        BLOB_STORAGE_FS_ROOT: root,
        MUNIN_LOCAL_MODE: 'true',
        MUNIN_BLOB_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'), // 16 bytes, not 32
      }),
    ).toThrow(BlobStorageError);
  });

  it('uses the key even without local mode (encryption is opt-in via the key)', async () => {
    const store = loadBlobStorageFromEnv({
      BLOB_STORAGE_IMPL: 'filesystem',
      BLOB_STORAGE_FS_ROOT: root,
      NODE_ENV: 'development',
      MUNIN_BLOB_ENCRYPTION_KEY: KEY_B64,
    });
    const uri = await store.put(TENANT_A, 'k.txt', new TextEncoder().encode('hello'));
    const onDisk = await readFile(fileURLToPath(uri));
    expect(new TextDecoder().decode(onDisk)).not.toContain('hello');
    expect(new TextDecoder().decode(await store.get(uri))).toBe('hello');
  });
});
