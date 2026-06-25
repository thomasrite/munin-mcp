// Gather-by-identity (M1.2) — GENERIC, vertical-agnostic, permission-correct.
//
// Assembles ALL of one resolved entity's records, leading with the EXACT KEY
// (complete-by-construction for key-bearing records — a structured read, not
// top-k), then the M1.1 cluster for the no-key remainder, then depth-1 graph
// traversal for attached records. This is the recall jump to ≥0.95 on top of
// M1.1 resolution.
//
// Permission architecture: EVERY
// read runs under the caller's ReadContext; there is NO internalBypass on the
// gather path. The key-LOOKUP itself is permission-scoped (findEntities applies
// the access filter before counting), so a guest can neither see nor count
// out-of-clearance key-bearing records — "matches 14, you see 3" would be a leak
// and cannot happen here. The uncertainty signal is computed ONLY over the
// caller-visible space and distinguishes two incompleteness sources:
//   • no-key / unlinked records → SURFACED (`mayHaveUnlinkedRecords`);
//   • permission-withheld records → NEVER surfaced or counted (that would leak
//     their existence). The gather simply does not know about them.
//
// The mechanism is generic: gather-by-property-value + entity-id union + depth-1
// neighbours, over opaque types/properties. WHICH property is the exact key is
// supplied by the configuration (M1.1 `exactKeyProperties`); the engine never
// names a vertical key.

import type { DocumentId, Entity, EntityId, ReadContext } from '../graph/types';
import type { GraphStoreReader } from './../graph/graph-store';

export interface GatherTarget {
  readonly entityType: string;
  // The exact-key property + the resolved entity's value, when available
  // (config `exactKeyProperties[0]`). Absent → no key-gather (cluster only).
  readonly keyProperty?: string;
  readonly keyValue?: string;
  // The M1.1 logical-cluster member ids (the resolved entity, for the no-key
  // remainder + traversal seeds). Already permission-filtered by the caller.
  readonly clusterMemberIds: readonly string[];
}

export interface GatherOptions {
  readonly expansionBreadth?: number; // depth-1 neighbour cap (default 25)
  readonly limit?: number; // max key-gather rows (default 1000)
}

export interface GatheredRecords {
  // Distinct gathered entity rows (visible only) and their source documents
  // (the "records"). Both scoped to the caller's clearance.
  readonly entityIds: readonly EntityId[];
  readonly documentIds: readonly DocumentId[];
  readonly viaKey: number; // entities gathered via the exact key
  readonly viaClusterOrTraversal: number; // additional entities (no-key remainder + neighbours)
  // Uncertainty (visible-scoped, no leak): some gathered records carry NO key, so
  // unlinked records of this entity may exist that the key-gather could not reach.
  // This NEVER reflects permission-withheld records.
  readonly mayHaveUnlinkedRecords: boolean;
}

function docIdOf(e: Entity): DocumentId | null {
  if (e.provenance.kind === 'document_extract') return e.provenance.documentId;
  if (e.provenance.kind === 'connector') return e.provenance.documentId;
  return null;
}

/**
 * Gather all of one resolved entity's records, key-led, permission-correct.
 * Reads only under `ctx` (no bypass). Generic; the key identity comes from config.
 */
export async function gatherByIdentity(
  reader: GraphStoreReader,
  ctx: ReadContext,
  target: GatherTarget,
  opts: GatherOptions = {},
): Promise<GatheredRecords> {
  const expansionBreadth = opts.expansionBreadth ?? 25;
  const limit = opts.limit ?? 1000;

  const byId = new Map<string, Entity>();
  const viaKeyIds = new Set<string>();

  // 1. Key-gather (the unlock): every visible entity bearing the exact key value.
  //    findEntities applies the access filter before counting → visible-scoped,
  //    no out-of-clearance count/existence leak.
  if (target.keyProperty && target.keyValue) {
    const page = await reader.findEntities(ctx, {
      types: [target.entityType],
      propertyEquals: { property: target.keyProperty, value: target.keyValue },
      limit,
    });
    for (const e of page.items) {
      byId.set(e.id, e);
      viaKeyIds.add(e.id);
    }
  }

  // 2. Cluster-gather (the no-key remainder): the resolved cluster's members.
  const clusterEntities = await reader.getEntitiesByIds(ctx, target.clusterMemberIds as EntityId[]);
  for (const e of clusterEntities) byId.set(e.id, e);

  // 3. Depth-1 graph traversal from everything gathered so far (records attached
  //    to the entity, e.g. a case that concerns it). Every read tag-filtered.
  const seeds = [...byId.keys()];
  for (const id of seeds) {
    const { entities: neighbours } = await reader.getNeighbours(ctx, id as EntityId, {
      direction: 'both',
      limit: expansionBreadth,
    });
    for (const nb of neighbours) byId.set(nb.id, nb);
  }

  // Records = distinct source documents of the gathered entities (visible only).
  const documentIds = new Set<DocumentId>();
  let hasKeyless = false;
  for (const e of byId.values()) {
    const did = docIdOf(e);
    if (did) documentIds.add(did);
    // A gathered entity that does NOT bear the key is an unlinked/no-key record:
    // its siblings might not be reachable by key. (Computed over visible rows only.)
    if (target.keyProperty) {
      const k = e.properties[target.keyProperty];
      if (k === undefined || k === null || k === '') hasKeyless = true;
    }
  }

  return {
    entityIds: [...byId.keys()] as EntityId[],
    documentIds: [...documentIds],
    viaKey: viaKeyIds.size,
    viaClusterOrTraversal: byId.size - viaKeyIds.size,
    // If there is no key at all, or some gathered records are keyless, there may
    // be unlinked records the key-gather could not reach. Never reflects withheld.
    mayHaveUnlinkedRecords: !target.keyValue || hasKeyless,
  };
}
