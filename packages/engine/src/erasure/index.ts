// Right-to-erasure — the public erasure entry points: per-document (P6b) and
// per-actor learning data (G2a/F55 DSAR leg).

export {
  eraseDocument,
  type ErasureReceipt,
  type ErasureStore,
  type EraseDocumentDeps,
} from './erase-document';
export {
  eraseActorLearning,
  type ActorLearningErasureCounts,
  type ActorLearningErasureReceipt,
} from './erase-actor-learning';
