// Disambiguation contract (M1.3) — GENERIC, vertical-agnostic, permission-correct.
//
// M1.1 resolution NEVER false-merges: when two same-name people cannot be safely
// confirmed as one, it leaves them as separate clusters and flags `ambiguous`.
// M1.3 turns that signal into an engine-side CONTRACT: package the ambiguous
// candidate clusters with the distinguishing info a caller needs to choose
// between them (present), then RE-GATHER (M1.2) for the chosen candidate (pick).
//
// THE BOUNDARY: the engine ships the stateless contract —
// `buildDisambiguation` (present), `selectCandidate` (pick), and
// `gatherTargetForCandidate` (bind the M1.2 gather). The conversational,
// multi-turn CHAT round-trip (rendering candidates, the clarification turn,
// editable workspace, human-in-the-loop) is M2; it wraps a UI around this
// contract. No conversation state is held here.
//
// NEVER-FALSE-MERGE PRESERVED (D2): a pick SELECTS which logical entity to
// gather — it never fuses two clusters into one and never writes a merge back.
// The M1.1 asymmetry stands; nothing here merges anything.
//
// PERMISSION-CORRECT (D3): this module is PURE over the already-resolved,
// already-visible entity set (it performs NO reads). So a same-name person whose
// records are entirely out of the caller's clearance produces no cluster in the
// caller's view → is never offered as a candidate. Distinguishing info + counts
// are computed only over the passed (visible) members. Re-gather runs the M1.2
// `gatherByIdentity`, which is itself permission-correct (no bypass).
//
// VERTICAL-AGNOSTIC (D4): the contract surfaces the values of config-NAMED
// properties (`EntityResolutionHints`); the engine names no vertical concept.

import { createHash } from 'node:crypto';

import type { EntityResolutionHints } from '@muninhq/shared';
import type { GatherTarget } from './gather';
import {
  type ResolutionResult,
  type ResolvableEntity,
  compatibleNames,
  nameTokens,
  validExactKey,
} from './resolution';

export interface DisambiguationCandidate {
  // Stable selection handle over the caller-visible cluster: a hash of the
  // sorted member ids (+ type). Deterministic — re-resolving the same visible
  // set reproduces the same token. If the underlying data changed between
  // present and pick, the token no longer matches any candidate and
  // `selectCandidate` returns null (the "candidate no longer available" case).
  readonly token: string;
  readonly logicalKey: string; // representative identity for display
  readonly entityType: string;
  readonly memberIds: readonly string[];
  // Values of the config distinguishing/identity properties, across the cluster's
  // VISIBLE members (distinct, non-empty). The info a caller uses to choose.
  readonly distinguishing: Readonly<Record<string, readonly string[]>>;
  // Count of caller-visible member rows. Visible-scoped — never a global total.
  readonly visibleRecordCount: number;
}

export interface DisambiguationGroup {
  // The shared identity the candidates collide on (representative; display only).
  readonly identityKey: string;
  readonly candidates: readonly DisambiguationCandidate[];
  // True when the resolver was UNSURE the candidates are distinct people (an
  // M1.1 `ambiguous` cluster is present) — vs CONFIDENTLY distinct (e.g. two
  // real people separated by a distinguishing property). Either way the caller
  // must pick; this annotates how the split was reached (the verifiable-
  // uncertainty story), it does not gate presentation.
  readonly resolverUncertain: boolean;
}

export interface DisambiguationResult {
  // One group per ambiguous identity that has >= 2 caller-visible candidate
  // clusters. Empty when resolution is unambiguous (the common path).
  readonly groups: readonly DisambiguationGroup[];
}

function candidateToken(entityType: string, memberIds: readonly string[]): string {
  const canonical = `${entityType}|${[...memberIds].sort().join(',')}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function distinguishingValues(
  members: readonly ResolvableEntity[],
  hints: EntityResolutionHints | undefined,
): Record<string, readonly string[]> {
  // distinguishing first (the discriminator, e.g. department), then identity props.
  const props = [...(hints?.distinguishingProperties ?? []), ...(hints?.identityProperties ?? [])];
  const out: Record<string, readonly string[]> = {};
  for (const p of props) {
    if (p in out) continue;
    const seen = new Set<string>();
    for (const m of members) {
      const v = m.properties[p];
      if (typeof v === 'string' && v.trim() !== '') seen.add(v);
      else if (typeof v === 'number' || typeof v === 'boolean') seen.add(String(v));
    }
    if (seen.size > 0) out[p] = [...seen].sort();
  }
  return out;
}

/**
 * Build the disambiguation candidate package from an M1.1 resolution result.
 * Pure: no I/O, no bypass. Operates only over the (visible) entities given, so
 * an out-of-clearance same-name person is structurally never surfaced.
 */
export function buildDisambiguation(
  resolution: ResolutionResult,
  entities: readonly ResolvableEntity[],
  hintsByType: ReadonlyMap<string, EntityResolutionHints>,
): DisambiguationResult {
  const byId = new Map(entities.map((e) => [e.id, e]));

  // EVERY cluster is a disambiguation candidate (NOT only `ambiguous` ones): a
  // name query matching >= 2 distinct logical clusters needs a pick whether the
  // resolver was unsure (`ambiguous`) OR confidently separated two real people
  // by a distinguishing property. The `ambiguous` flag is carried per candidate
  // to annotate the group's uncertainty, not to gate which clusters appear.
  interface Cand {
    readonly logicalKey: string;
    readonly entityType: string;
    readonly memberIds: readonly string[];
    readonly ambiguous: boolean;
  }
  const cands: Cand[] = [];
  for (const c of resolution.clusters) {
    const first = c.memberIds
      .map((id) => byId.get(id))
      .find((e): e is ResolvableEntity => e !== undefined);
    if (!first) continue; // members not in the visible set — skip (cannot happen via the pipeline)
    cands.push({
      logicalKey: c.logicalKey,
      entityType: first.type,
      memberIds: c.memberIds,
      ambiguous: c.ambiguous,
    });
  }

  // Group ambiguous candidates that share an identity: same type AND
  // name-compatible representative names (reuses the resolver's name logic, so
  // "Sarah Jones" and a bridging "S. Jones" land in the same question).
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    return r;
  };
  for (let i = 0; i < cands.length; i++) parent.set(i, i);
  for (let i = 0; i < cands.length; i++) {
    const ci = cands[i];
    if (ci === undefined) continue;
    for (let j = i + 1; j < cands.length; j++) {
      const cj = cands[j];
      if (cj === undefined) continue;
      if (ci.entityType !== cj.entityType) continue;
      if (compatibleNames(nameTokens(ci.logicalKey), nameTokens(cj.logicalKey))) {
        parent.set(find(i), find(j));
      }
    }
  }
  const grouped = new Map<number, number[]>();
  for (let i = 0; i < cands.length; i++) {
    const r = find(i);
    const g = grouped.get(r);
    if (g) g.push(i);
    else grouped.set(r, [i]);
  }

  const groups: DisambiguationGroup[] = [];
  for (const idxs of grouped.values()) {
    if (idxs.length < 2) continue; // a lone cluster is not a disambiguation question
    const candidates: DisambiguationCandidate[] = idxs
      .flatMap((i) => {
        const c = cands[i];
        return c ? [c] : [];
      })
      .map((c) => {
        const members = c.memberIds
          .map((id) => byId.get(id))
          .filter((e): e is ResolvableEntity => e !== undefined);
        return {
          token: candidateToken(c.entityType, c.memberIds),
          logicalKey: c.logicalKey,
          entityType: c.entityType,
          memberIds: c.memberIds,
          distinguishing: distinguishingValues(members, hintsByType.get(c.entityType)),
          visibleRecordCount: members.length,
        };
      })
      // Deterministic order: by token (stable, content-derived).
      .sort((a, b) => a.token.localeCompare(b.token));
    const resolverUncertain = idxs.some((i) => cands[i]?.ambiguous ?? false);
    const firstCandidate = candidates[0];
    if (firstCandidate === undefined) continue;
    groups.push({ identityKey: firstCandidate.logicalKey, candidates, resolverUncertain });
  }
  // Deterministic group order.
  groups.sort((a, b) => a.identityKey.localeCompare(b.identityKey));
  return { groups };
}

/**
 * The "pick" step: resolve a selection token to its candidate. Returns null when
 * the token matches no current candidate (the data changed since present →
 * "candidate no longer available, re-resolve" — the caller should re-present).
 * Pure.
 */
export function selectCandidate(
  result: DisambiguationResult,
  token: string,
): DisambiguationCandidate | null {
  for (const g of result.groups) {
    for (const c of g.candidates) {
      if (c.token === token) return c;
    }
  }
  return null;
}

/**
 * Bind the chosen candidate to an M1.2 `GatherTarget` (key-led when the config
 * exact key is present on a member, else cluster-only). Pure; the caller passes
 * the result to `gatherByIdentity`, which reads only under the caller's
 * ReadContext. The pick is a gather-target selection, NEVER a merge (D2).
 */
export function gatherTargetForCandidate(
  candidate: DisambiguationCandidate,
  entitiesById: ReadonlyMap<string, ResolvableEntity>,
  hintsByType: ReadonlyMap<string, EntityResolutionHints>,
): GatherTarget {
  return gatherTargetForCluster(
    candidate.entityType,
    candidate.memberIds,
    entitiesById,
    hintsByType,
  );
}

/**
 * Bind a resolved single cluster (the no-collision path) to an M1.2
 * `GatherTarget` — key-led when the config exact key is present on a member,
 * else cluster-only. The single-cluster analogue of `gatherTargetForCandidate`
 * (which is now a thin wrapper over this). Pure; the caller passes the result to
 * `gatherByIdentity`, which reads only under the caller's ReadContext.
 */
export function gatherTargetForCluster(
  entityType: string,
  memberIds: readonly string[],
  entitiesById: ReadonlyMap<string, ResolvableEntity>,
  hintsByType: ReadonlyMap<string, EntityResolutionHints>,
): GatherTarget {
  const hints = hintsByType.get(entityType);
  const keyProp = hints?.exactKeyProperties?.[0];
  let keyValue: string | undefined;
  if (keyProp) {
    for (const id of memberIds) {
      // Use validExactKey so a pattern-failing value (e.g. a case/document ref
      // grabbed as a person's ref) is NOT bound as the gather key — otherwise a
      // key-led gather would re-pull a different person's records (the silent merge
      // at the gather level). Falls to cluster-only, matching the resolver.
      const v = validExactKey(entitiesById.get(id)?.properties[keyProp], keyProp, hints);
      if (v !== null) {
        keyValue = v;
        break;
      }
    }
  }
  return {
    entityType,
    ...(keyProp && keyValue ? { keyProperty: keyProp, keyValue } : {}),
    clusterMemberIds: memberIds,
  };
}
