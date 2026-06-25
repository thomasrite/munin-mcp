// Azure Blob Storage implementation of the BlobStorage interface.
//
// Supports three auth modes:
//   - devkey         : Azurite-style shared-key auth. Refused in prod builds.
//   - connection-string : connection string from env (real Azure).
//   - managed-identity  : DefaultAzureCredential (G3 production rig). No
//     standing credential anywhere — the platform identity authenticates, and
//     the rig's storage account has shared-key auth disabled outright.
//
// One container per tenant. The container name is
// `${containerPrefix}${tenantId}` so per-tenant ACLs and per-tenant CMK can
// be configured at the Azure-resource level.

import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  type ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

import type { TenantId } from '../graph/types';
import { BlobNotFoundError, type BlobStorage, BlobStorageError } from './blob-storage';

export type BlobStorageAuthMode = 'devkey' | 'connection-string' | 'managed-identity';

export interface AzureBlobStorageConfig {
  readonly authMode: BlobStorageAuthMode;
  readonly endpoint?: string; // devkey requires this
  readonly accountName?: string; // devkey requires this
  readonly accountKey?: string; // devkey requires this
  readonly connectionString?: string; // connection-string mode requires this
  readonly containerPrefix: string;
}

export class AzureBlobStorage implements BlobStorage {
  private readonly serviceClient: BlobServiceClient;
  private readonly containerPrefix: string;
  private readonly knownContainers = new Set<string>();

  constructor(config: AzureBlobStorageConfig) {
    this.containerPrefix = config.containerPrefix;
    switch (config.authMode) {
      case 'devkey': {
        if (!config.endpoint || !config.accountName || !config.accountKey) {
          throw new BlobStorageError('devkey auth requires endpoint, accountName, accountKey');
        }
        const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
        this.serviceClient = new BlobServiceClient(config.endpoint, credential);
        break;
      }
      case 'connection-string': {
        if (!config.connectionString) {
          throw new BlobStorageError('connection-string auth requires connectionString');
        }
        this.serviceClient = BlobServiceClient.fromConnectionString(config.connectionString);
        break;
      }
      case 'managed-identity': {
        // DefaultAzureCredential resolves the platform identity at first use
        // (construction is offline): managed identity on Container Apps,
        // az-CLI/dev credentials locally. The endpoint names the account —
        // there is no key, and the G3 rig disables shared-key auth entirely.
        if (!config.endpoint) {
          throw new BlobStorageError(
            'managed-identity auth requires endpoint (https://<account>.blob.core.windows.net)',
          );
        }
        this.serviceClient = new BlobServiceClient(config.endpoint, new DefaultAzureCredential());
        break;
      }
    }
  }

  async ensureTenantContainer(tenantId: TenantId): Promise<void> {
    const name = this.containerName(tenantId);
    if (this.knownContainers.has(name)) return;
    const client = this.serviceClient.getContainerClient(name);
    try {
      await client.createIfNotExists();
      this.knownContainers.add(name);
    } catch (err) {
      throw new BlobStorageError(`failed to ensure container ${name}`, err);
    }
  }

  async put(
    tenantId: TenantId,
    relativePath: string,
    bytes: Uint8Array,
    options?: { contentType?: string },
  ): Promise<string> {
    await this.ensureTenantContainer(tenantId);
    const containerClient = this.containerClient(tenantId);
    const blobClient = containerClient.getBlockBlobClient(relativePath);
    try {
      await blobClient.uploadData(bytes, {
        blobHTTPHeaders: options?.contentType ? { blobContentType: options.contentType } : {},
      });
      return blobClient.url;
    } catch (err) {
      throw new BlobStorageError(
        `failed to upload ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async get(uri: string): Promise<Uint8Array> {
    const { containerName, blobName } = parseUri(uri);
    const containerClient = this.serviceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    try {
      const response = await blobClient.downloadToBuffer();
      return new Uint8Array(response);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) throw new BlobNotFoundError(uri);
      throw new BlobStorageError(`failed to download ${uri}`, err);
    }
  }

  async exists(uri: string): Promise<boolean> {
    const { containerName, blobName } = parseUri(uri);
    const containerClient = this.serviceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    try {
      return await blobClient.exists();
    } catch (err) {
      throw new BlobStorageError(`failed to check existence of ${uri}`, err);
    }
  }

  // Right-to-erasure (P6b). IDEMPOTENT: deleteIfExists is a no-op when the blob
  // is already gone, and a 404 is likewise treated as success (already gone ==
  // erased) so an erasure retry is safe. parseUri rejects a malformed URI.
  async delete(uri: string): Promise<void> {
    const { containerName, blobName } = parseUri(uri);
    const containerClient = this.serviceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    try {
      await blobClient.deleteIfExists();
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return; // already gone == erased
      throw new BlobStorageError(`failed to delete ${uri}`, err);
    }
  }

  private containerName(tenantId: TenantId): string {
    return `${this.containerPrefix}${tenantId}`;
  }

  private containerClient(tenantId: TenantId): ContainerClient {
    return this.serviceClient.getContainerClient(this.containerName(tenantId));
  }
}

// Azure blob URIs look like:
//   https://<account>.blob.core.windows.net/<container>/<blob path>
//   http://127.0.0.1:10000/devstoreaccount1/<container>/<blob path>   (Azurite)
// We just split on the path segments.
function parseUri(uri: string): { containerName: string; blobName: string } {
  const url = new URL(uri);
  const pathSegments = url.pathname.split('/').filter(Boolean);
  // Azurite path begins with the account name (e.g. devstoreaccount1) then
  // container then blob. Real Azure has only container/blob.
  // We detect Azurite by whether the host is 127.0.0.1/localhost.
  const isAzurite = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const offset = isAzurite ? 1 : 0;
  const containerName = pathSegments[offset];
  if (!containerName) throw new BlobStorageError(`cannot parse container from URI: ${uri}`);
  const blobName = pathSegments.slice(offset + 1).join('/');
  if (!blobName) throw new BlobStorageError(`cannot parse blob name from URI: ${uri}`);
  return { containerName, blobName };
}
