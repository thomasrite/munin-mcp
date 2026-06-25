// Env-driven construction of BlobStorage. Centralises the production-safety
// check (refuse devkey in prod builds) and the auth-mode selection.

import {
  AzureBlobStorage,
  type AzureBlobStorageConfig,
  type BlobStorageAuthMode,
} from './azure-blob-storage';
import { type BlobStorage, BlobStorageError } from './blob-storage';
import { FilesystemBlobStorage } from './filesystem-blob-storage';

export interface BlobStorageEnv {
  // Storage backend: 'azure' (default, hosted) | 'filesystem' (local/desktop, P1).
  readonly BLOB_STORAGE_IMPL?: string;
  readonly BLOB_STORAGE_AUTH_MODE?: string;
  readonly BLOB_STORAGE_ENDPOINT?: string;
  readonly BLOB_STORAGE_ACCOUNT_NAME?: string;
  readonly BLOB_STORAGE_ACCOUNT_KEY?: string;
  readonly BLOB_STORAGE_CONNECTION_STRING?: string;
  readonly BLOB_STORAGE_CONTAINER_PREFIX?: string;
  // Root directory for the filesystem backend.
  readonly BLOB_STORAGE_FS_ROOT?: string;
  // Base64-encoded 32-byte AES-256-GCM key for at-rest encryption of filesystem
  // blobs (P2). Generate with `openssl rand -base64 32`. Mandatory in local mode
  // (see below); optional otherwise. Never commit this — Key Vault / OS keychain.
  readonly MUNIN_BLOB_ENCRYPTION_KEY?: string;
  // Explicit opt-in that allows local-mode adapters under NODE_ENV=production
  // (e.g. a packaged desktop build). Defence-in-depth, mirrors the devkey guard.
  // Also makes filesystem-blob encryption mandatory: a local-mode filesystem
  // backend without MUNIN_BLOB_ENCRYPTION_KEY is refused (never store plaintext).
  readonly MUNIN_LOCAL_MODE?: string;
  readonly NODE_ENV?: string;
}

const ENCRYPTION_KEY_BYTES = 32;

// Parse the base64 at-rest key, or undefined when unset. A present-but-malformed
// key (wrong length / not base64) is a hard error — fail fast rather than fall
// back to plaintext silently.
function parseBlobEncryptionKey(env: BlobStorageEnv): Uint8Array | undefined {
  const raw = env.MUNIN_BLOB_ENCRYPTION_KEY?.trim();
  if (!raw) return undefined;
  const key = new Uint8Array(Buffer.from(raw, 'base64'));
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new BlobStorageError(
      `MUNIN_BLOB_ENCRYPTION_KEY must decode to ${ENCRYPTION_KEY_BYTES} bytes for AES-256-GCM ` +
        `(got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

const VALID_MODES: readonly BlobStorageAuthMode[] = [
  'devkey',
  'connection-string',
  'managed-identity',
];

const DEFAULT_FS_ROOT = './.munin-local/blobs';

export function loadBlobStorageFromEnv(env: BlobStorageEnv = process.env): BlobStorage {
  const impl = (env.BLOB_STORAGE_IMPL ?? 'azure').toLowerCase();
  if (impl === 'filesystem') {
    // Production-safety: filesystem blobs are a local/desktop convenience and
    // must not be selected by a hosted production deploy by accident. Refuse
    // hard unless an explicit local-mode flag opts in (same shape as the devkey
    // guard below).
    const nodeEnv = (env.NODE_ENV ?? 'development').toLowerCase();
    const localOptIn = (env.MUNIN_LOCAL_MODE ?? '').toLowerCase() === 'true';
    if (nodeEnv === 'production' && !localOptIn) {
      throw new BlobStorageError(
        'BLOB_STORAGE_IMPL=filesystem is refused when NODE_ENV=production. ' +
          'Set MUNIN_LOCAL_MODE=true to allow the local filesystem backend in a packaged build.',
      );
    }
    const encryptionKey = parseBlobEncryptionKey(env);
    // Encryption is default-ON in local mode: a local-mode filesystem backend
    // without a key would silently store document plaintext on disk, which the
    // P2 privacy guarantee forbids. Fail fast rather than degrade quietly.
    if (localOptIn && encryptionKey === undefined) {
      throw new BlobStorageError(
        'MUNIN_LOCAL_MODE=true requires MUNIN_BLOB_ENCRYPTION_KEY for the filesystem backend ' +
          '(at-rest encryption is mandatory in local mode; plaintext blobs are refused). ' +
          'Generate one with: openssl rand -base64 32',
      );
    }
    const root = env.BLOB_STORAGE_FS_ROOT?.trim() || DEFAULT_FS_ROOT;
    return new FilesystemBlobStorage({
      root,
      ...(encryptionKey ? { encryptionKey } : {}),
    });
  }
  if (impl !== 'azure') {
    throw new BlobStorageError(
      `BLOB_STORAGE_IMPL='${impl}' is not one of: azure (default), filesystem`,
    );
  }

  // No-egress guard (P1-1, blob leg): in local mode the Azure backend — whether
  // selected explicitly or reached via the silent default — is refused at
  // construction, exactly like the cloud AI providers in the provider factory.
  // The Azure SDK is node:https-based (outside the egress dispatcher's scope),
  // so this structural refusal is what makes the no-egress-audit's "not
  // selected in local mode" claim true unconditionally.
  if ((env.MUNIN_LOCAL_MODE ?? '').toLowerCase() === 'true') {
    throw new BlobStorageError(
      `MUNIN_LOCAL_MODE=true forbids the 'azure' blob backend${env.BLOB_STORAGE_IMPL === undefined ? ' (the silent default — BLOB_STORAGE_IMPL was unset)' : ''} — it sends document bytes off-machine. Local mode requires BLOB_STORAGE_IMPL=filesystem.`,
    );
  }

  const rawMode = (env.BLOB_STORAGE_AUTH_MODE ?? 'devkey').toLowerCase();
  const authMode = VALID_MODES.find((m) => m === rawMode);
  if (!authMode) {
    throw new BlobStorageError(
      `BLOB_STORAGE_AUTH_MODE='${rawMode}' is not one of: ${VALID_MODES.join(', ')}`,
    );
  }

  // Production-safety: devkey is for Azurite/dev only. A production build
  // that boots with devkey is a misconfiguration with potential security
  // implications (well-known credentials baked into a deployment). Refuse
  // hard at startup rather than risk it.
  const nodeEnv = (env.NODE_ENV ?? 'development').toLowerCase();
  if (authMode === 'devkey' && nodeEnv === 'production') {
    throw new BlobStorageError(
      'BLOB_STORAGE_AUTH_MODE=devkey is refused when NODE_ENV=production. ' +
        "The Azurite dev key is publicly known; production must use 'managed-identity' or 'connection-string'.",
    );
  }

  const containerPrefix = env.BLOB_STORAGE_CONTAINER_PREFIX ?? 'munin-tenant-';

  const config: AzureBlobStorageConfig = {
    authMode,
    containerPrefix,
    ...(env.BLOB_STORAGE_ENDPOINT !== undefined ? { endpoint: env.BLOB_STORAGE_ENDPOINT } : {}),
    ...(env.BLOB_STORAGE_ACCOUNT_NAME !== undefined
      ? { accountName: env.BLOB_STORAGE_ACCOUNT_NAME }
      : {}),
    ...(env.BLOB_STORAGE_ACCOUNT_KEY !== undefined
      ? { accountKey: env.BLOB_STORAGE_ACCOUNT_KEY }
      : {}),
    ...(env.BLOB_STORAGE_CONNECTION_STRING !== undefined
      ? { connectionString: env.BLOB_STORAGE_CONNECTION_STRING }
      : {}),
  };

  return new AzureBlobStorage(config);
}
