// Filesystem-backed BlobStorage for the local/desktop runtime (P1).
//
// Stores raw document bytes under a root directory, one sub-directory per tenant
// (the "container"), with canonical file:// URIs. Same BlobStorage contract as
// the Azure adapter — only the storage medium differs — so the ingestion
// pipeline is unchanged. Zero network: writes and reads are local disk.
//
// Tenant isolation is by directory: a tenant's blobs live only under
// <root>/<tenantId>/. Relative paths are validated to never escape that
// directory (no `..` traversal), and get/exists only accept file:// URIs that
// resolve back inside the root.
//
// At-rest encryption (P2). With an `encryptionKey` (32 bytes) the raw document
// bytes are stored as AES-256-GCM ciphertext — `iv (12) || ciphertext || authTag
// (16)` — so a stolen disk yields no plaintext. get() verifies the auth tag and
// throws on tampering. Only the raw blob bytes are encrypted; the searchable
// columns (embedding vectors, access_tags) live in the PGlite index and stay
// plaintext (protect them via OS-level volume encryption, not column crypto).
// Without a key the store is plaintext — the P1 contract is unchanged.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TenantId } from '../graph/types';
import { BlobNotFoundError, type BlobStorage, BlobStorageError } from './blob-storage';

// AES-256-GCM at-rest framing. A fresh 96-bit IV per blob (never reused under one
// key), a 128-bit auth tag. Key length is fixed by the algorithm.
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface FilesystemBlobStorageConfig {
  // Root directory under which per-tenant container directories are created.
  readonly root: string;
  // Optional 32-byte AES-256-GCM key. When present, blob bytes are encrypted at
  // rest; when absent, they are stored as plaintext (the P1 behaviour).
  readonly encryptionKey?: Uint8Array;
}

export class FilesystemBlobStorage implements BlobStorage {
  private readonly root: string;
  private readonly encryptionKey?: Uint8Array;

  constructor(config: FilesystemBlobStorageConfig) {
    // Absolute root so file:// URIs are stable regardless of process CWD at
    // read time.
    this.root = path.resolve(config.root);
    if (config.encryptionKey !== undefined) {
      if (config.encryptionKey.length !== KEY_BYTES) {
        throw new BlobStorageError(
          `encryptionKey must be ${KEY_BYTES} bytes for AES-256-GCM (got ${config.encryptionKey.length})`,
        );
      }
      this.encryptionKey = config.encryptionKey;
    }
  }

  // iv || ciphertext || authTag. A unique random IV per blob means identical
  // plaintext never produces identical ciphertext. The key is passed in (already
  // narrowed by the caller's truthiness check) so no non-null cast is needed.
  private encrypt(bytes: Uint8Array, key: Uint8Array): Uint8Array {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, authTag]);
  }

  // Inverse of encrypt(); a verification failure (tampered bytes / wrong key)
  // surfaces as BlobStorageError, never plaintext.
  private decrypt(stored: Uint8Array, key: Uint8Array): Uint8Array {
    if (stored.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new BlobStorageError('encrypted blob is too short to contain an IV and auth tag');
    }
    const iv = stored.subarray(0, IV_BYTES);
    const authTag = stored.subarray(stored.length - AUTH_TAG_BYTES);
    const ciphertext = stored.subarray(IV_BYTES, stored.length - AUTH_TAG_BYTES);
    try {
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    } catch (err) {
      throw new BlobStorageError('failed to decrypt blob (auth tag mismatch or wrong key)', err);
    }
  }

  private containerDir(tenantId: TenantId): string {
    return path.join(this.root, tenantId);
  }

  // Resolve a tenant-relative path to an absolute path, refusing anything that
  // escapes the tenant container (path traversal).
  private resolveWithin(tenantId: TenantId, relativePath: string): string {
    const container = this.containerDir(tenantId);
    const abs = path.resolve(container, relativePath);
    const rel = path.relative(container, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new BlobStorageError(`relativePath '${relativePath}' escapes the tenant container`);
    }
    return abs;
  }

  async ensureTenantContainer(tenantId: TenantId): Promise<void> {
    await mkdir(this.containerDir(tenantId), { recursive: true });
  }

  async put(
    tenantId: TenantId,
    relativePath: string,
    bytes: Uint8Array,
    _options?: { contentType?: string },
  ): Promise<string> {
    const abs = this.resolveWithin(tenantId, relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    // Encrypt at rest when a key is configured; otherwise store plaintext (P1).
    const onDisk = this.encryptionKey ? this.encrypt(bytes, this.encryptionKey) : bytes;
    await writeFile(abs, onDisk);
    return pathToFileURL(abs).href;
  }

  async get(uri: string): Promise<Uint8Array> {
    const abs = this.pathFromUri(uri);
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch (err) {
      if (isEnoent(err)) throw new BlobNotFoundError(uri);
      throw new BlobStorageError(`failed to read ${uri}`, err);
    }
    const stored = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    // Decrypt (and verify) when a key is configured; otherwise the bytes are
    // the plaintext as written. A decryption failure throws BlobStorageError —
    // never silently returns ciphertext.
    return this.encryptionKey ? this.decrypt(stored, this.encryptionKey) : stored;
  }

  async exists(uri: string): Promise<boolean> {
    const abs = this.pathFromUri(uri);
    try {
      await access(abs, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Right-to-erasure (P6b). Unlink the file (no decryption needed — erasure just
  // removes the bytes). IDEMPOTENT: a missing file (ENOENT) is success — already
  // gone == erased — so an erasure retry never fails on a half-completed prior
  // run. pathFromUri applies the same outside-the-root traversal guard as get().
  async delete(uri: string): Promise<void> {
    const abs = this.pathFromUri(uri);
    try {
      await unlink(abs);
    } catch (err) {
      if (isEnoent(err)) return; // already gone == erased
      throw new BlobStorageError(`failed to delete ${uri}`, err);
    }
  }

  // Parse a canonical file:// URI back to an absolute path, refusing anything
  // that resolves outside this store's root (defence in depth).
  private pathFromUri(uri: string): string {
    let abs: string;
    try {
      abs = fileURLToPath(uri);
    } catch {
      throw new BlobStorageError(`not a file:// URI: ${uri}`);
    }
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new BlobStorageError(`URI resolves outside the blob root: ${uri}`);
    }
    return abs;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
