// Connector plugin contract.
//
// Every data source — filesystem, mailbox/document sources, MIS-style imports — implements
// the same `Connector` interface. The ingestion pipeline iterates whatever
// the connector yields and applies the standard processing (idempotency,
// parsing, chunking, persistence, embedding-job emission).
//
// `ConnectorRecord` is a discriminated union so document-style and
// entity-stream sources share one entry point. Phase 1.5 implements only
// the `document` variant; the `entity` variant exists in the type
// definition but the pipeline raises `NotImplementedError` on encountering
// one until session 4.2.

import type { GraphStore } from '../graph/graph-store';
import type { TenantId } from '../graph/types';

export interface ConnectorContext {
  readonly tenantId: TenantId;
  // GraphStore exposed so a connector can read its own connector_state
  // row (cursor, delta token, etc.). Reads should use a bypass context
  // since cursor lookups are system operations not tied to a user.
  readonly graphStore: GraphStore;
}

export type ConnectorTenantConfig = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Documents (Phase 1.5 + 4.1)
// ---------------------------------------------------------------------------

export interface DocumentSource {
  // Stable id within this connector for this tenant. Used together with
  // `connectorPackage` for idempotent upsert on subsequent syncs.
  readonly externalId: string;
  readonly title: string;
  readonly mimeType?: string;
  readonly sourceModifiedAt?: Date;
  // Lazy access to bytes. Fetched only when ingestion decides to process
  // this document (e.g. when the content hash isn't already present).
  fetchBytes(): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Entity stream (MIS-style structured imports)
// ---------------------------------------------------------------------------
//
// The shape is held open here so the connector contract doesn't change when
// entity connectors land. The pipeline throws `NotImplementedError` on
// encountering an entity record until session 4.2 implements handling.

export interface EntityImport {
  readonly externalId: string;
  readonly entityType: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Union the connector yields
// ---------------------------------------------------------------------------

export type ConnectorRecord =
  | { kind: 'document'; document: DocumentSource }
  | { kind: 'entity'; entity: EntityImport };

export interface Connector {
  readonly packageName: string;
  readonly humanName: string;
  list(config: ConnectorTenantConfig, ctx: ConnectorContext): AsyncIterable<ConnectorRecord>;
}

// Thrown by the pipeline when it encounters a record kind it doesn't yet
// support. Carries the connector identifier so the operator log is useful.
export class NotImplementedConnectorRecordError extends Error {
  constructor(
    public readonly connectorPackage: string,
    public readonly recordKind: string,
  ) {
    super(
      `connector ${connectorPackage} yielded a '${recordKind}' record; the pipeline does not yet handle this kind`,
    );
    this.name = 'NotImplementedConnectorRecordError';
  }
}
