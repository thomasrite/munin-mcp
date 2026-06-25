// Public surface of the engine's data-access layer.

export * from './types';
export * from './errors';
export type { GraphStore, GraphStoreReader, GraphStoreWriter } from './graph-store';
export { PostgresGraphStore } from './postgres-graph-store';
export { AuditedGraphStore } from './audited-graph-store';
export {
  BatchedReadAuditWriter,
  readAuditEnabled,
  type BatchedReadAuditWriterOptions,
  type ReadAuditDb,
  type ReadAuditEvent,
  type ReadAuditSink,
} from './read-audit';
// NOTE: the local-runtime backend selector (loadGraphStore) and the PGlite
// bootstrap are deliberately NOT re-exported here. They live behind the
// `@muninhq/engine/graph-store` subpath so importing the engine root never pulls
// the PGlite/WASM dependency into a static bundle (e.g. the Next.js web build),
// and the frozen minimal root surface is unchanged. See graph-store-factory.ts.
