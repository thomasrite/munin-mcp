// Typed Error subclasses for the expected GraphStore failure modes.

export class GraphStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphStoreError';
  }
}

export class NotFoundError extends GraphStoreError {
  constructor(
    public readonly kind: string,
    public readonly id: string,
  ) {
    super(`${kind} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class InvalidProvenanceError extends GraphStoreError {
  constructor(message: string) {
    super(`invalid provenance: ${message}`);
    this.name = 'InvalidProvenanceError';
  }
}

// A would-be cross-tenant write detected at the engine layer. With the
// current API there is no parameter that lets a caller specify a tenant
// other than `ctx.tenantId`, so this error is mostly a defence-in-depth
// guarantee that the implementation never silently writes against a
// different tenant. Thrown if internal invariants drift.
export class CrossTenantWriteError extends GraphStoreError {
  constructor(message: string) {
    super(`cross-tenant write rejected: ${message}`);
    this.name = 'CrossTenantWriteError';
  }
}

export class DuplicateError extends GraphStoreError {
  constructor(message: string) {
    super(`duplicate: ${message}`);
    this.name = 'DuplicateError';
  }
}

// The local PGlite store could not be opened (F71): the underlying WASM instance
// aborted on open/migrate — the signature of a locked or corrupt on-disk pgdata
// (most often a second process having opened the same data dir). Surfaced instead
// of the raw `RuntimeError: Aborted()` so callers can give recovery guidance. The
// original error is preserved as `cause`. LOCAL-MODE ONLY.
export class LocalStoreUnavailableError extends GraphStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'LocalStoreUnavailableError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
