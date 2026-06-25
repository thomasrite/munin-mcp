// Query-time entity resolution (M1.1) — GENERIC, PURE, vertical-agnostic.
//
// Clusters the name-form variants of one real-world entity into a read-time
// "logical entity", WITHOUT touching stored rows (decisions-14: no destructive
// merge; provenance stays honest). The result is a per-query view.
//
// Permission architecture: this module is PURE over the entity
// set it is GIVEN — it performs NO reads and NO internalBypass. The query
// pipeline reads entities under the caller's ReadContext (tenant + access-tag
// filtered) and passes only the caller-visible set in, so the resolver cannot
// peek past the permission filter and cannot leak identity signal from
// out-of-clearance rows.
//
// Asymmetric bar: two same-name
// rows are merged ONLY when there is positive confirmation they are the same
// entity — an exact config natural-key match, OR context (embedding) proximity
// within `confirmDistance`. Divergent / weak / missing context → DO NOT merge →
// the cluster is flagged `ambiguous` (the M1.3 disambiguation hook). This makes
// false-merge ≈ 0 by construction; coherence is the informative casualty, not a
// gate. A configured `distinguishingProperties` difference always BLOCKS a merge.

import type { EntityResolutionHints } from '@muninhq/shared';

export interface ResolvableEntity {
  readonly id: string;
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
  // The entity's context vector (e.g. its source-paragraph embedding, or a
  // property-derived embedding — the CALLER chooses; the resolver is agnostic).
  // null when unavailable → treated as "context cannot confirm" (conservative).
  readonly contextVector: readonly number[] | null;
}

export interface LogicalCluster {
  // Representative normalised identity for the cluster (display/debug only).
  readonly logicalKey: string;
  readonly memberIds: readonly string[];
  // True when name-compatible candidates were left UNMERGED for want of
  // confirmation (same name, distinct/uncertain context) — i.e. this identity
  // is shared across clusters and may need user disambiguation (M1.3).
  readonly ambiguous: boolean;
}

export interface ResolutionResult {
  readonly clusters: readonly LogicalCluster[];
}

export interface ResolutionOptions {
  // Confirm-to-merge threshold: merge name-compatible candidates only when their
  // context-vector cosine distance is <= this. Smaller = more conservative.
  readonly confirmDistance?: number;
}

// Conservative default: tight enough
// that even WITHOUT a config identity signal, context does not false-merge the
// same/variant-name collision case — a false-split is the recoverable error, a
// false-merge is not. The config exact-key force-confirms legitimate key-backed
// merges regardless of this threshold, so it recovers most of the coherence the
// tighter threshold would otherwise cost; the residual cost bites only the
// no-key, same/variant-name case (which we should split — recoverable in M1.2/M1.3).
const DEFAULT_CONFIRM_DISTANCE = 0.25;
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'mx', 'sir']);

// ---------------------------------------------------------------------------
// Name normalisation + compatibility (generic, name-form aware)
// ---------------------------------------------------------------------------
function identityString(e: ResolvableEntity, hints: EntityResolutionHints | undefined): string {
  const props = hints?.identityProperties;
  if (!props || props.length === 0) return '';
  return props
    .map((p) => e.properties[p])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' ')
    .trim();
}

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TITLES.has(t));
}

// Two tokenised names are compatible if they share a surname (last token) and
// their leading tokens are pairwise compatible (equal, or one is an initial of
// the other, or one is absent). Handles "Helena Voss" ~ "Ms Voss" ~ "H. Voss"
// and treats two identical names (the decoys) as compatible — leaving CONTEXT
// as the sole discriminator for same-name-different-person.
export function compatibleNames(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a[a.length - 1] !== b[b.length - 1]) return false; // surname must match
  const aFirst = a.slice(0, -1);
  const bFirst = b.slice(0, -1);
  const n = Math.max(aFirst.length, bFirst.length);
  for (let i = 0; i < n; i++) {
    const x = aFirst[i];
    const y = bFirst[i];
    if (x === undefined || y === undefined) continue; // one absent → compatible
    if (x === y) continue;
    if (x.length === 1 && y.startsWith(x)) continue; // x is initial of y
    if (y.length === 1 && x.startsWith(y)) continue; // y is initial of x
    return false;
  }
  return true;
}

function surnameKey(tokens: string[]): string {
  return tokens.at(-1) ?? '';
}

function sameTokens(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

// A name is "under-specified" if it gives no distinguishing given-name signal —
// surname only ("Ms Smith" → ["smith"]) or a single initial ("J. Smith"). Such a
// form cannot be safely merged in a FORKED block (one shared by ≥2 distinct
// people), because it could belong to either. Exported so the query-time routing
// seam (resolve-target) can tell a full-name query from an under-specified one.
export function isUnderspecified(tokens: string[]): boolean {
  const given = tokens.slice(0, -1);
  return given.length === 0 || given.some((t) => t.length === 1);
}

// ---------------------------------------------------------------------------
// Context proximity
// ---------------------------------------------------------------------------
function cosineDistance(u: readonly number[], v: readonly number[]): number {
  let dot = 0;
  let nu = 0;
  let nv = 0;
  const len = Math.min(u.length, v.length);
  for (let i = 0; i < len; i++) {
    const ui = u[i] ?? 0;
    const vi = v[i] ?? 0;
    dot += ui * vi;
    nu += ui * ui;
    nv += vi * vi;
  }
  if (nu === 0 || nv === 0) return 1;
  return 1 - dot / (Math.sqrt(nu) * Math.sqrt(nv));
}

// ---------------------------------------------------------------------------
// Config-hint merge gates
// ---------------------------------------------------------------------------
function exactKeyMatch(
  a: ResolvableEntity,
  b: ResolvableEntity,
  hints: EntityResolutionHints | undefined,
): boolean {
  const keys = hints?.exactKeyProperties;
  if (!keys || keys.length === 0) return false;
  for (const k of keys) {
    const av = a.properties[k];
    const bv = b.properties[k];
    if (
      av === undefined ||
      av === null ||
      av === '' ||
      bv === undefined ||
      bv === null ||
      bv === ''
    )
      return false;
    if (av !== bv) return false;
  }
  return true;
}

// THE CATASTROPHE GUARD (F9): two rows carry DIFFERENT non-empty values for a
// config exact key (employeeRef / email) → they are DEFINITIVELY different
// entities. This BLOCKS a merge unconditionally — name compatibility, context
// proximity, and the no-context recall rule below can never override it. Without
// this, a variant pair like "Helena Voss"(EMP-001) ~ "H. Voss"(EMP-002) — two
// genuinely-different same-surname people — could be wrongly merged. A
// false-merge of HR records is a data breach; a key conflict is hard proof of
// distinctness, so it always wins.
function conflictingExactKey(
  a: ResolvableEntity,
  b: ResolvableEntity,
  hints: EntityResolutionHints | undefined,
): boolean {
  const keys = hints?.exactKeyProperties;
  if (!keys || keys.length === 0) return false;
  for (const k of keys) {
    const av = a.properties[k];
    const bv = b.properties[k];
    const aHas = typeof av === 'string' ? av.trim() !== '' : av !== undefined && av !== null;
    const bHas = typeof bv === 'string' ? bv.trim() !== '' : bv !== undefined && bv !== null;
    if (aHas && bHas && av !== bv) return true;
  }
  return false;
}

function distinguishingDiffers(
  a: ResolvableEntity,
  b: ResolvableEntity,
  hints: EntityResolutionHints | undefined,
): boolean {
  const keys = hints?.distinguishingProperties;
  if (!keys || keys.length === 0) return false;
  for (const k of keys) {
    const av = a.properties[k];
    const bv = b.properties[k];
    if (
      av !== undefined &&
      av !== null &&
      av !== '' &&
      bv !== undefined &&
      bv !== null &&
      bv !== '' &&
      av !== bv
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Exact-key value validation (wrong-key guard)
// ---------------------------------------------------------------------------
// Compiled-pattern cache — resolution runs per query over the visible set, so we
// avoid recompiling the (few, config-supplied) key regexes per entity.
const keyPatternCache = new Map<string, RegExp | null>();
// Defensive bound on a config-supplied pattern: cap its source length so a
// pathological (ReDoS-prone) expression cannot be compiled, and `try/catch` the
// compile so a malformed source cannot throw mid-query. The length cap is a
// mitigation, not a complete ReDoS guard.
const MAX_KEY_PATTERN_LENGTH = 200;

// Compile a config key pattern DEFENSIVELY: an over-long or malformed source
// compiles to `null` ("no pattern" — the value is simply not pattern-filtered,
// never crashing the query). The result (including the null) is cached, so the
// one-time warning for a bad pattern fires at most once per distinct source.
function compiledKeyPattern(source: string): RegExp | null {
  const cached = keyPatternCache.get(source);
  if (cached !== undefined) return cached; // includes a cached null (already-rejected)
  let compiled: RegExp | null = null;
  if (source.length > MAX_KEY_PATTERN_LENGTH) {
    console.warn(
      `[resolution] ignoring exactKeyPattern: source length ${source.length} exceeds ${MAX_KEY_PATTERN_LENGTH}-char cap`,
    );
  } else {
    try {
      compiled = new RegExp(source);
    } catch (err) {
      console.warn(
        `[resolution] ignoring malformed exactKeyPattern: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  keyPatternCache.set(source, compiled);
  return compiled;
}

// A value bound to an exact-key property is a VALID identity key only if it is a
// non-empty string AND — when the configuration declares a key pattern for that
// property — matches it. A value that fails the pattern (e.g. a case/document
// reference grabbed as a person's ref — Experiment B/C) is NOT a key: it returns
// null so the resolver treats the entity as KEYLESS for that property (the safe
// cluster-only path) rather than force a confident, silent merge on a wrong key.
// GENERIC: the engine knows only that the property HAS a pattern; the pattern's
// meaning is the configuration's (Rule 1).
export function validExactKey(
  value: unknown,
  keyProp: string,
  hints: EntityResolutionHints | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return null;
  const pattern = hints?.exactKeyPatterns?.[keyProp];
  if (pattern !== undefined) {
    const re = compiledKeyPattern(pattern);
    // A malformed/over-long pattern compiles to null → treat as "no pattern" (no
    // filtering): accept the value rather than crash. A valid pattern that the
    // value fails → null (the value is not a key for this property).
    if (re !== null && !re.test(value)) return null;
  }
  return value;
}

// Resolution VIEW of an entity with any pattern-failing exact-key value REMOVED
// from its properties (stored rows untouched — resolution is a per-query view,
// decisions-14). A stripped value leaves the entity KEYLESS, never dropped, so a
// wrong key can never reach exactKeyMatch / conflictingExactKey / block detection.
function stripInvalidExactKeys(
  e: ResolvableEntity,
  hints: EntityResolutionHints | undefined,
): ResolvableEntity {
  const keyProps = hints?.exactKeyProperties;
  if (!keyProps?.length || !hints?.exactKeyPatterns) return e;
  let changed = false;
  const props: Record<string, unknown> = { ...e.properties };
  for (const k of keyProps) {
    const v = props[k];
    if (typeof v === 'string' && v.trim() !== '' && validExactKey(v, k, hints) === null) {
      delete props[k]; // present but pattern-failing → omit (entity kept, keyless)
      changed = true;
    }
  }
  return changed ? { ...e, properties: props } : e;
}

// ---------------------------------------------------------------------------
// Union-Find
// ---------------------------------------------------------------------------
class DisjointSet {
  private readonly parent = new Map<string, string>();
  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  find(id: string): string {
    let root = id;
    let parentOfRoot = this.parent.get(root);
    while (parentOfRoot !== undefined && parentOfRoot !== root) {
      root = parentOfRoot;
      parentOfRoot = this.parent.get(root);
    }
    let cur = id;
    let parentOfCur = this.parent.get(cur);
    while (parentOfCur !== undefined && parentOfCur !== root) {
      this.parent.set(cur, root);
      cur = parentOfCur;
      parentOfCur = this.parent.get(cur);
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Resolve a set of (already permission-filtered) entities into logical clusters.
 * Pure: no I/O, no bypass. Vertical-agnostic; vertical specifics come only from
 * `hintsByType` (the configuration identity-hook).
 */
export function resolveEntities(
  rawEntities: readonly ResolvableEntity[],
  hintsByType: ReadonlyMap<string, EntityResolutionHints>,
  opts: ResolutionOptions = {},
): ResolutionResult {
  const confirmDistance = opts.confirmDistance ?? DEFAULT_CONFIRM_DISTANCE;
  // Normalise first: strip exact-key VALUES that fail the configured key pattern, so
  // a wrong key (a case/document reference grabbed as a person's ref) is treated as
  // absent everywhere below and can never force a confident merge. Entities are kept
  // (keyless); ids are preserved, so clustering and downstream are unaffected.
  const entities = rawEntities.map((e) => stripInvalidExactKeys(e, hintsByType.get(e.type)));
  const ds = new DisjointSet();
  for (const e of entities) ds.add(e.id);

  // Group by type; within a type, block by surname to bound comparisons.
  const byType = new Map<string, ResolvableEntity[]>();
  for (const e of entities) {
    const list = byType.get(e.type);
    if (list) list.push(e);
    else byType.set(e.type, [e]);
  }

  // Track, per surname block, whether name-compatible candidates were left
  // unmerged (→ ambiguous identity shared across clusters).
  const ambiguousRoots = new Set<string>();

  for (const [type, group] of byType) {
    const hints = hintsByType.get(type);
    if (!hints?.identityProperties || hints.identityProperties.length === 0) continue; // no identity → no resolution

    const toks = new Map<string, string[]>();
    for (const e of group) toks.set(e.id, nameTokens(identityString(e, hints)));

    const blocks = new Map<string, ResolvableEntity[]>();
    for (const e of group) {
      const key = surnameKey(toks.get(e.id) ?? []);
      if (key === '') continue;
      const block = blocks.get(key);
      if (block) block.push(e);
      else blocks.set(key, [e]);
    }

    for (const block of blocks.values()) {
      // A block holds MULTIPLE DISTINCT IDENTITIES when it contains either:
      //   • ≥2 distinct well-specified given names for the surname ("Jane Smith"
      //     + "John Smith" — FORKED), or
      //   • ≥2 distinct non-empty exact keys (two key-distinct people who happen
      //     to share a surname — possibly the SAME full name, e.g. two "Helena
      //     Voss" with employeeRefs EMP-001 / EMP-002).
      // Either way an under-specified variant ("Ms Voss", "H. Voss") could belong
      // to more than one of them → it must NOT be auto-attached (F9 recall rule
      // below is suppressed; it stays ambiguous for M1.3 disambiguation).
      const wellSpecified = new Set<string>();
      const distinctKeys = new Set<string>();
      for (const e of block) {
        const given = (toks.get(e.id) ?? []).slice(0, -1).filter((t) => t.length > 1);
        if (given.length) wellSpecified.add(given.join(' '));
        for (const k of hints.exactKeyProperties ?? []) {
          const v = e.properties[k];
          // Type-tag the value so "distinct keys" agrees with conflictingExactKey's
          // raw `!==`: a numeric 1 and a string "1" are DISTINCT keys (and a
          // conflict), so the block is multi-identity and no keyless variant may
          // bridge them. Without the tag they'd collide here and a bridge could form.
          if (typeof v === 'string' && v.trim() !== '') distinctKeys.add(`${k}=s:${v}`);
          else if (typeof v === 'number') distinctKeys.add(`${k}=n:${v}`);
          else if (typeof v === 'boolean') distinctKeys.add(`${k}=b:${v}`);
        }
      }
      const blockMultiIdentity = wellSpecified.size >= 2 || distinctKeys.size >= 2;

      for (let i = 0; i < block.length; i++) {
        for (let j = i + 1; j < block.length; j++) {
          const a = block[i];
          const b = block[j];
          if (a === undefined || b === undefined) continue;
          const ta = toks.get(a.id) ?? [];
          const tb = toks.get(b.id) ?? [];
          if (!compatibleNames(ta, tb)) continue;
          if (distinguishingDiffers(a, b, hints)) continue; // positive evidence of distinct → block
          // THE CATASTROPHE GUARD: a key conflict is hard proof of distinctness —
          // never merged, on any signal. NOT flagged ambiguous: the resolver is
          // CERTAIN they are different people (they just share a name).
          if (conflictingExactKey(a, b, hints)) continue;

          if (exactKeyMatch(a, b, hints)) {
            ds.union(a.id, b.id); // confident, context-independent — overrides risk
            continue;
          }

          // TRANSITIVE-BRIDGE GUARD (F9, airtight): in a MULTI-IDENTITY block (≥2
          // distinct exact keys, or ≥2 distinct given names) the union is the ONLY
          // place two key-distinct people could be wrongly fused — directly, OR
          // TRANSITIVELY through a keyless variant that name-matches both (e.g.
          // "Helena Voss"(EMP-001) ~ "Helena Marie Voss"(keyless) ~ "Helena
          // Voss"(EMP-002)). The per-pair key-conflict guard above only blocks the
          // direct pair, so here we forbid ALL non-exact-key unions: in a multi-
          // identity block only exact-key matches merge; every other compatible
          // pair stays AMBIGUOUS for M1.3. A SINGLE-identity block has ≤1 distinct
          // key, so no cross-key cluster can form there — making this guarantee
          // structural (no cluster can ever contain two distinct exact keys).
          if (blockMultiIdentity) {
            ambiguousRoots.add(ds.find(a.id));
            ambiguousRoots.add(ds.find(b.id));
            continue;
          }

          // SINGLE-IDENTITY block (≤1 distinct key, ≤1 distinct given name). Two
          // IDENTICAL WELL-SPECIFIED full names with no key could still be two
          // distinct un-keyed people sharing a name → refuse (safe split). (Two
          // identical UNDER-specified forms — "Ms Voss" twice — are just the same
          // person mentioned twice; not risky on that account.)
          const bothWellSpecified = !isUnderspecified(ta) && !isUnderspecified(tb);
          if (sameTokens(ta, tb) && bothWellSpecified) {
            ambiguousRoots.add(ds.find(a.id));
            ambiguousRoots.add(ds.find(b.id));
            continue;
          }

          // A NON-risky name-form VARIANT pair ("Helena Voss" ~ "H. Voss" ~ "Ms
          // Voss") in a single-identity block, no key conflict. Merge unless
          // context POSITIVELY contradicts:
          //   • context present + close → confirmed merge;
          //   • context present + diverges (> confirmDistance) → refuse (ambiguous);
          //   • context ABSENT (the production case — F9) → MERGE. There is no
          //     competing identity in this block and no contrary signal, so a
          //     keyless variant has a unique home; clustering it is what lets
          //     gather reach the fragmented records.
          let contextDiverges = false;
          if (a.contextVector !== null && b.contextVector !== null) {
            contextDiverges = cosineDistance(a.contextVector, b.contextVector) > confirmDistance;
          }
          if (contextDiverges) {
            ambiguousRoots.add(ds.find(a.id));
            ambiguousRoots.add(ds.find(b.id));
          } else {
            ds.union(a.id, b.id);
          }
        }
      }
    }
  }

  // Build clusters from the disjoint set.
  const members = new Map<string, string[]>();
  const repName = new Map<string, string>();
  const idToEntity = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    const root = ds.find(e.id);
    const memberList = members.get(root);
    if (memberList) memberList.push(e.id);
    else members.set(root, [e.id]);
  }
  // After unions, re-evaluate ambiguity against final roots.
  const finalAmbiguous = new Set<string>();
  for (const r of ambiguousRoots) finalAmbiguous.add(ds.find(r));

  const clusters: LogicalCluster[] = [];
  for (const [root, memberIds] of members) {
    const rep = idToEntity.get(root);
    if (rep === undefined) continue;
    const hints = hintsByType.get(rep.type);
    if (!repName.has(root)) repName.set(root, identityString(rep, hints) || rep.type);
    clusters.push({
      logicalKey: repName.get(root) ?? rep.type,
      memberIds,
      ambiguous: finalAmbiguous.has(root),
    });
  }
  return { clusters };
}
