// Blob storage interface for raw document bytes.
//
// Production uses Azure Blob Storage with managed identity. Development uses
// Azurite (local emulator) with the well-known dev key. Same code path; only
// the configuration differs. The factory enforces that the dev key auth-mode
// is refused in production builds.

import type { TenantId } from '../graph/types';

export class BlobStorageError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BlobStorageError';
  }
}

export class BlobNotFoundError extends BlobStorageError {
  constructor(uri: string) {
    super(`blob not found: ${uri}`);
    this.name = 'BlobNotFoundError';
  }
}

export interface BlobStorage {
  // Put bytes at the given path within the tenant's container. Returns the
  // canonical URI (the full https://... URL in production, or the Azurite
  // equivalent in dev).
  put(
    tenantId: TenantId,
    relativePath: string,
    bytes: Uint8Array,
    options?: { contentType?: string },
  ): Promise<string>;

  // Read bytes by canonical URI.
  get(uri: string): Promise<Uint8Array>;

  // Check existence by canonical URI.
  exists(uri: string): Promise<boolean>;

  // Delete the blob at the given canonical URI (right-to-erasure, P6b).
  // IDEMPOTENT: deleting a blob that is already gone is success (already-gone ==
  // erased), so an erasure retry is safe. Applies the same URI/path validation
  // as get() — a URI that escapes the store's root is rejected, never silently
  // ignored.
  delete(uri: string): Promise<void>;

  // Ensure the tenant's container exists. Called during tenant provisioning
  // and as a self-healing first step on ingestion. Idempotent.
  ensureTenantContainer(tenantId: TenantId): Promise<void>;
}
