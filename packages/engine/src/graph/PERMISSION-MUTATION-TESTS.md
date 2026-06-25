# Permission Mutation Tests

This document is the manual safety net behind the permission suites: the
dedicated P0 matrix [`../permissions/permission-matrix.int.test.ts`](../permissions/permission-matrix.int.test.ts)
and [`graph-store.int.test.ts`](./graph-store.int.test.ts). If a future change to `PostgresGraphStore` accidentally weakens the access-tag, tenant-isolation, or bypass-audit machinery, at least one of the documented mutations below must cause a specific test to fail. If you can introduce the mutation and the suite stays green, the suite is incomplete and needs strengthening before the change can land.

This is not a full mutation-testing framework (no Stryker). It is a checklist a reviewer or a future contributor runs by hand when touching the access-control machinery.

## What is automated vs manual (session 1.9)

- **Automated (CI, default `pnpm test`):** the **access-tag filter** dimension is machine-checked by the canary in `permission-matrix.int.test.ts` ("CANARY — the access-tag battery is sensitive to the filter"). It wraps the store in `VulnerableGraphStoreReader` (which downgrades regular reads to bypass — the engine's real "drop the tag filter" mechanism) and asserts the visibility assertions then *leak*, proving they have teeth. So **Mutation 1 / Mutation 6 are effectively automated** — but keep them here too, as the canary tests the *assertions*, not the production line itself.
- **Manual (this checklist):** tenant-isolation drop (Mutation 3/4), bypass-audit drop (Mutation 5), soft-delete drop/cascade (Mutation 7/8), and the `getNeighbours` far-endpoint check (Mutation 9). These need a production-line edit to simulate cleanly, so they remain a hand-run checklist.

> **Current `readFilters` shape (for reference).** Regular reads push tenant + soft-delete + an access-tag overlap; an empty caller tag set becomes a `FALSE` clause. The mutation snippets below match this current form.

## Backend parity — the guarantees hold on PGlite too (P1)

The local/desktop runtime (P1) reuses the **unchanged** `PostgresGraphStore` over a
PGlite handle (Postgres compiled to WASM, in-process). There is **no second store
and no second permission path**, so every mutation below applies identically to the
local backend. [`../permissions/backend-parity.int.test.ts`](../permissions/backend-parity.int.test.ts)
proves this by MEASUREMENT: one shared assertion body runs over a `{ postgres, pglite }`
backend matrix, covering the access-tag filter (incl. the empty-set fail-closed),
cross-tenant isolation, vector + keyword search no-leak, **cross-tenant vector
isolation with BYTE-IDENTICAL vectors** (vec2text / OWASP LLM08 — the vector index
stays tenant-partitioned even when two tenants store the same vector; a mutation
that dropped the tenant predicate from `searchByVector` would surface the other
tenant's identical-vector row and fail this case on both backends), the
query-pipeline end-to-end no-leak, and the bypass-log append-only path. The PGlite backend runs
in-process (no Docker); the Postgres backend is included when a Docker runtime is
reachable. Because the production line (`readFilters`, `withBypassLogging`,
`searchByVector`/`searchByKeyword`) is shared, a mutation that breaks Postgres breaks
PGlite, and the parity suite fails on **both** rows of the matrix. (Baseline `it()`
count tracked in `expected-case-counts.json`.)

## How to run a mutation test

1. Save the current `postgres-graph-store.ts`.
2. Apply one of the mutations below (a one-line edit).
3. Run `pnpm test:int`.
4. Confirm at least one of the *expected failing tests* fails.
5. Revert the mutation.

If step 4 fails — the suite stays green despite the mutation — open a new test that catches it, then continue.

---

## Mutation 1 — drop the access-tag filter for regular reads

**Mutation:** in `readFilters`, replace the access-tag branch

```ts
if (ctx.kind === 'regular') {
  if (ctx.accessTags.length === 0) {
    out.push(sql`FALSE`);
  } else {
    const literal = toPgTextArrayLiteral(ctx.accessTags);
    out.push(sql`${table.accessTags} && ${literal}::text[]`);
  }
}
```

with

```ts
if (ctx.kind === 'regular') {
  out.push(sql`TRUE`);
}
```

**Effect:** every regular read now ignores the caller's access tags and returns all rows of the tenant.

**Also automated:** the `permission-matrix.int.test.ts` canary catches this exact weakness via `VulnerableGraphStoreReader`.

**Expected failing tests:**
- `access-tag intersection (any-of) > caller with non-overlapping tag does not see entity`
- `access-tag intersection (any-of) > caller with empty tag set sees nothing (not "no filter")`
- `access-tag intersection (any-of) > entity with empty tags is invisible to non-empty callers (symmetric)`
- `getNeighbours triple filter > omits neighbour when far endpoint is invisible to caller`
- `getNeighbours triple filter > omits neighbour when edge itself is invisible`
- `INTERNAL_BYPASS > returns entities the caller would normally not see` (the "blocked" assertion before the bypass call would unexpectedly see the entity)

## Mutation 2 — change any-of to all-of intersection

**Mutation:** swap the array-overlap operator `&&` for the array-contains operator `<@`:

```ts
out.push(sql`${table.accessTags} <@ ${ctx.accessTags as string[]}::text[]`);
```

**Effect:** caller now needs to hold *every* tag the entity has, not just one of them.

**Expected failing tests:**
- `access-tag intersection (any-of) > caller with one of many tags sees entity (any-of, not all-of)`
- `access-tag intersection (any-of) > caller with overlapping tag sees entity` (for the multi-tag entity case)

## Mutation 3 — drop tenant isolation on reads

**Mutation:** in `readFilters`, remove the line:

```ts
eq(table.tenantId, ctx.tenantId),
```

**Effect:** reads see rows across all tenants as long as the access-tag filter passes.

**Expected failing tests:**
- `tenant isolation > getEntity: tenant B cannot see entity inserted by tenant A even with matching tags`
- `tenant isolation > getEntitiesByIds: cross-tenant ids filtered out silently`
- `tenant isolation > findEntities: tenant A sees its own entities only`
- `tenant isolation > getDocument: tenant isolation`
- `tenant isolation > getParagraph: tenant isolation`
- `INTERNAL_BYPASS > does not bypass tenant isolation`

## Mutation 4 — drop tenant isolation on writes

**Mutation:** in `insertEntity`, change

```ts
tenantId: ctx.tenantId,
```

to a hardcoded `TENANT_A` value, or to `params.id ? someValueFromParams : ctx.tenantId`.

**Effect:** writes land in the wrong tenant.

**Expected failing tests:**
- `tenant isolation > findEntities: tenant A sees its own entities only` (count will be wrong)
- The fixture seeding itself may fail with foreign-key errors against the wrong tenant.

## Mutation 5 — drop the bypass audit-log write

**Mutation:** in `withBypassLogging`, change

```ts
if (ctx.kind === 'regular') return fn(this.db);
return this.db.transaction(async (tx) => {
  await tx.insert(internalBypassLog).values({ ... });
  return fn(tx);
});
```

to

```ts
return fn(this.db);
```

**Effect:** bypass reads still work but no audit row is written.

**Expected failing tests:**
- `INTERNAL_BYPASS > writes an internal_bypass_log row in the same transaction` (the row count assertion fails)

## Mutation 6 — bypass treats accessTags = [] as no-filter

**Mutation:** add a special case in `readFilters` such that empty `accessTags` is treated as "skip filter":

```ts
if (ctx.kind === 'regular' && ctx.accessTags.length > 0) {
  out.push(sql`${table.accessTags} && ${ctx.accessTags as string[]}::text[]`);
}
```

**Effect:** a caller with no tags now sees everything in their tenant — the exact bug we explicitly designed against.

**Expected failing tests:**
- `access-tag intersection (any-of) > caller with empty tag set sees nothing (not "no filter")`

## Mutation 7 — drop soft-delete filter

**Mutation:** in `readFilters`, remove the line:

```ts
isNull(table.deletedAt),
```

**Effect:** soft-deleted rows become visible to regular reads.

**Expected failing tests:**
- `soft-delete cascade > softDeleteEntity also soft-deletes incident edges` (the assertions on `e1`/`e2` would unexpectedly find the soft-deleted edges)

## Mutation 8 — soft-delete does not cascade to edges

**Mutation:** in `softDeleteEntity`, remove the inner `tx.update(edges).set(...).where(...)` call.

**Effect:** soft-deleting an entity leaves incident edges intact.

**Expected failing tests:**
- `soft-delete cascade > softDeleteEntity also soft-deletes incident edges` (the assertions on `e1` and `e2` would fail because the edges are still visible)

## Mutation 9 — getNeighbours skips the far-endpoint visibility check

**Mutation:** in `getNeighbours`, change the `visibleFarIds` filter so it does not actually fetch with access-filter applied:

```ts
const visibleFar = candidateEdgeRows.map((row) => /* … no access filter … */);
```

**Effect:** edges with invisible far endpoints leak through.

**Expected failing tests:**
- `getNeighbours triple filter > omits neighbour when far endpoint is invisible to caller`

## Mutation 10 — `findEntitiesByParagraphIds` drops the access filter

**Mutation:** in `findEntitiesByParagraphIds`, replace `this.readFilters(ctx, entities)` with just `[eq(entities.tenantId, ctx.tenantId)]` (tenant only, no tag/soft-delete).

**Effect:** the query layer's expansion entry point returns entities the caller can't see.

**Expected failing tests:**
- `permission-matrix > reader: entity visibility > findEntitiesByParagraphIds: pub caller sees only pub entity from the paragraph`
- `permission-matrix > reader: entity visibility > findEntitiesByParagraphIds: empty tags return nothing`
- The query-pipeline no-leak test (`permissions/query-leak.int.test.ts`) would also surface a restricted entity reaching the grounding set.

## Mutation 11 — `searchByVector` drops the access-tag filter

**Mutation:** in `searchByVector`, delete the `if (ctx.kind === 'regular') { … accessTags && … }` block so only tenant + model + soft-delete remain.

**Effect:** vector search returns embeddings for paragraphs the caller can't see.

**Expected failing tests:**
- `permission-matrix > reader: searchByVector > returns only paragraphs whose tags the caller holds`
- `permission-matrix > reader: searchByVector > empty tags return nothing`
- the `query-leak` no-leak tests.

## Mutation 12 — `getDocumentsByIds` / `getParagraphsByIds` drop the access filter

**Mutation:** in either batched reader, replace `this.readFilters(ctx, table)` with just `[eq(table.tenantId, ctx.tenantId)]` (tenant only, no tag/soft-delete).

**Effect:** the query layer's paragraph materialisation / document-title lookup returns rows the caller can't see — the most direct content-leak path, since these feed the grounding prompt.

**Expected failing tests:**
- `permission-matrix > reader: document & paragraph visibility > getDocumentsByIds: filters to the visible subset silently`
- `permission-matrix > reader: document & paragraph visibility > getDocumentsByIds: empty tags return nothing`
- `permission-matrix > reader: document & paragraph visibility > getParagraphsByIds: filters to the visible subset silently`
- `permission-matrix > reader: document & paragraph visibility > getParagraphsByIds: empty tags return nothing`
- the `query-leak` no-leak tests (paragraph materialisation runs through `getParagraphsByIds`).

## Mutation 13 — `findParagraphsPendingExtraction` drops the access filter

**Mutation:** in `findParagraphsPendingExtraction`, replace `this.readFilters(ctx, paragraphs)` with just `[eq(paragraphs.tenantId, ctx.tenantId)]`.

**Effect:** the extraction CLI's pending-discovery read would surface paragraphs outside the caller's tags. Lower blast radius (its only caller passes a bypass context, where the tag filter is already and intentionally off), but the method is a general reader and must enforce the filter for any regular caller.

**Expected failing tests:**
- `permission-matrix > reader: findParagraphsPendingExtraction visibility > pub caller sees only the pub paragraph as pending, never the secret one`
- `permission-matrix > reader: findParagraphsPendingExtraction visibility > empty tags return nothing`

## Mutation 14 — `findDocuments` drops the access filter

**Mutation:** in `findDocuments`, replace `this.readFilters(ctx, documents)` with just `[eq(documents.tenantId, ctx.tenantId)]` (tenant only).

**Effect:** the dashboard's recent-ingestions list and document-browser (D2) would list — and count — documents the caller can't see. A direct content/metadata leak on the first screen after login.

**Expected failing tests:**
- `permission-matrix > reader: document & paragraph visibility > findDocuments: lists + counts only the visible, own-tenant subset`
- `permission-matrix > reader: document & paragraph visibility > findDocuments: empty tags return nothing (total 0)`
- `permission-matrix > CANARY — ... > the vulnerable store also leaks the secret document via findDocuments`

(Note: `findRecentQueryEvents` is deliberately NOT access-tag filtered — it is tenant + actor-scoped telemetry carrying no content. Its guard is the tenant-isolation case in `reader: tenant-scoped operational reads`, not a tag mutation.)

## Mutation 15 — duplicate-link readers leak across a tag boundary (P3a)

Two new readers added for near/semantic duplicate links (`document_duplicates`).
Both must enforce the access filter; `findDuplicatesForDocument` must additionally
require BOTH endpoint documents be visible, so a link never reveals the existence
of a document the caller cannot see.

**Mutation A — `findDocumentFingerprints` drops the access filter:** replace
`this.readFilters(ctx, documents)` with just `[eq(documents.tenantId, ctx.tenantId)]`.
**Effect:** the near-dup scan reader returns fingerprints for documents the caller can't see.
**Expected failing tests:**
- `permission-matrix > reader: duplicate links visibility (P3a) > findDocumentFingerprints: pub caller sees only the pub fingerprint`
- `permission-matrix > reader: duplicate links visibility (P3a) > findDocumentFingerprints: empty tags return nothing`

**Mutation B — `findDuplicatesForDocument` only filters the queried endpoint
(not the counterpart):** drop the `...otherFilters` (the `other` alias readFilters)
from the `where` so only the queried document's visibility is enforced.
**Effect:** a caller who can see document X learns X is a duplicate of confidential
document Y (existence leak), even though Y is outside their clearance.
**Expected failing tests:**
- `permission-matrix > reader: duplicate links visibility (P3a) > NO-LEAK: a pub caller querying the pub doc gets nothing (secret counterpart hidden)`
- `permission-matrix > reader: duplicate links visibility (P3a) > NO-LEAK: a secret caller querying the secret doc gets nothing (pub counterpart hidden)`

**Mutation C — drop tenant scoping on the links:** remove
`eq(documentDuplicates.tenantId, ctx.tenantId)` from the `where`.
**Effect:** cross-tenant duplicate links surface.
**Expected failing tests:**
- `permission-matrix > reader: duplicate links visibility (P3a) > tenant B cannot see tenant A duplicate links`

(The `VulnerableGraphStoreReader` canary also covers both readers — they downgrade
the context like every other reader, so a dropped-filter regression is doubly caught.)

## Mutation 16 — versioning reader/writer drop their scope (P3a)

`findLatestLiveDocumentByExternalId` (the re-ingest version lookup) is access-tag
filtered; `supersedeDocument` (marks a prior version superseded) is tenant-scoped.

**Mutation A — `findLatestLiveDocumentByExternalId` drops the access filter:**
replace `this.readFilters(ctx, documents)` with just `[eq(documents.tenantId, ctx.tenantId)]`.
**Effect:** a regular caller learns a restricted document exists under a known externalId.
**Expected failing tests:**
- `permission-matrix > reader/writer: versioning (P3a) > findLatestLiveDocumentByExternalId: pub caller does NOT find the secret document`
- `permission-matrix > reader/writer: versioning (P3a) > findLatestLiveDocumentByExternalId: empty tags find nothing`

**Mutation B — `supersedeDocument` drops tenant scoping:** remove
`eq(documents.tenantId, ctx.tenantId)` from the `where`.
**Effect:** a write from one tenant could stamp `valid_to` on another tenant's document.
**Expected failing tests:**
- `permission-matrix > reader/writer: versioning (P3a) > supersedeDocument: tenant B cannot supersede tenant A document (write tenant-scoped)`

**Mutation C — `findLatestLiveDocumentByExternalId` drops the `validTo IS NULL`
filter:** remove that predicate.
**Effect:** the lookup could return a SUPERSEDED version as if it were live,
breaking the version chain on the next re-ingest.
**Expected failing tests:**
- `permission-matrix > reader/writer: versioning (P3a) > findLatestLiveDocumentByExternalId: a superseded version is NOT returned (only the live one)`

---

## Mutation: query-time entity resolution clusters over rows the caller cannot see (M1.1)

**Code path:** `query/resolution.ts` (`resolveEntities`) is PURE — it clusters only the entity
set it is GIVEN, performs no reads, and issues no `internalBypass`. The permission guarantee is
architectural: the query pipeline feeds it the result of a normal access-tag-filtered read
(`findEntities` under the caller's `ReadContext`), so a hidden, out-of-clearance row of the same
person is never in the input and therefore cannot appear in — or influence — the cluster.
Aggregation ("everything about X") must not become a permission bypass.

**Plausible mutation:** the pipeline (or a future gather path) reads candidate entities under a
bypass / unfiltered context "to resolve better", OR `resolveEntities` is given the full row set
and asked to filter internally. Either would let a guest's cluster include or be shaped by a
record they cannot see (an identity/existence-signal leak).

**Expected failing tests (`permissions/resolution-permission.int.test.ts`):**
- `resolution — permission scope (P0) > a guest resolves only over visible rows; the out-of-clearance row is absent from input AND output`
- `resolution — permission scope (P0) > the hidden row does not INFLUENCE the visible cluster (identical with and without it)`

(Backstop: `resolveEntities` is pure and unit-tested in `query/resolution.test.ts`; the P0 int
test proves the *read feeding it* is permission-scoped, which is where a leak could be introduced.)

---

## Mutation: gather-by-identity / key-gather leaks out-of-clearance records (M1.2)

**Code path:** `findEntities` with `propertyEquals` (the generic key-gather read) and
`query/gather.ts` (`gatherByIdentity`). The access filter is applied INSIDE `findEntities` before
the `count()`, so both rows and the `total` are scoped to caller-visible records. `gatherByIdentity`
reads only under the caller's `ReadContext` (no `internalBypass`); its uncertainty flag is computed
over the visible set only and never reflects withheld records.

**Plausible mutation:** (a) the `propertyEquals` filter is applied to row selection but the
`count()` is computed without the access filter ("matches 14, you see 3" — an existence leak);
(b) `gatherByIdentity` reads candidates under a bypass "to be complete"; (c) the uncertainty flag
is set from a global count, leaking that withheld records exist.

**Expected failing tests:**
- `permission-matrix > reader: entity visibility > findEntities propertyEquals (M1.2 key-gather): rows AND count are visible-scoped — no out-of-clearance leak`
- `permission-matrix > CANARY … > the vulnerable store also leaks via findEntities propertyEquals (M1.2 key-gather)`
- `gather-permission > gather-by-identity — permission scope (P0) > a guest gather returns only the permitted records …`
- `gather-permission > … > NO-LEAK: a guest gather result AND uncertainty flag are byte-identical with and without a hidden record`

---

## Mutation: disambiguation reveals an out-of-clearance same-name person (M1.3)

**Code path:** `query/disambiguation.ts` (`buildDisambiguation`). It is PURE over the entity set it
is given (the caller-visible read) — no reads, no `internalBypass`. So a same-name person whose
records are entirely out of the caller's clearance produces no cluster in the caller's view and is
never packaged as a candidate; distinguishing info + counts are computed only over visible members.

**Plausible mutation:** the disambiguation path is "completed" with an `internalBypass` / unfiltered
read to find ALL same-name people regardless of clearance "so the user sees every option" — leaking
the existence of a confidential second person (e.g. offering a guest "Sarah Jones (Westfield)" they
cannot see).

**Expected failing tests (`permissions/disambiguation-permission.int.test.ts`):**
- `disambiguation — permission scope (P0) > a guest is NEVER offered the out-of-clearance same-name person`
- `disambiguation — permission scope (P0) > NO-LEAK: the guest result is byte-identical whether or not the hidden person exists`

(Backstop: `buildDisambiguation`/`selectCandidate`/`gatherTargetForCandidate` are pure and
unit-tested in `query/disambiguation.test.ts`; re-gather uses the M1.2 `gatherByIdentity`, already
covered above. The P0 int test proves the *read feeding it* is permission-scoped.)

---

## Mutation 17 — review-queue readers drop their access filter (P6a)

The governed-correction queue (`review_queue`) added two ACCESS-GATED readers:
`getReviewItem` (one item by id) and `findPendingReviewItems` (the steward's
pending list). Both apply the SAME access-tag overlap as every content read via
the shared `accessTagOverlapClause` — a steward must NEVER see a queued
correction for a target outside their clearance. The row carries the TARGET's
access tags (copied at enqueue), so "can the steward see the target?" reduces to
the standard array-overlap.

**Mutation A — `findPendingReviewItems` drops the access filter:** in
`findPendingReviewItems`, omit the `accessTagOverlapClause(ctx, reviewQueue.accessTags)`
push so only `tenant + status='pending'` remain.
**Effect:** a steward sees every tenant's pending corrections regardless of clearance —
including a queued edit to a confidential record they may not read (an existence +
content leak of the proposed change).
**Expected failing tests (`permissions/permission-matrix.int.test.ts`):**
- `reader: review-queue visibility (P6a) > findPendingReviewItems: pub caller sees ONLY the pub-tagged item`
- `reader: review-queue visibility (P6a) > findPendingReviewItems: empty tags see NOTHING (fail-closed)`
- `CANARY — … > the vulnerable store also leaks a secret review item via findPendingReviewItems (P6a)`

**Mutation B — `getReviewItem` drops the access filter:** omit the same clause so a
caller can fetch any item by id.
**Effect:** a steward (or any caller) could fetch — and then act on — a queued
correction for a target they cannot see.
**Expected failing tests:**
- `reader: review-queue visibility (P6a) > getReviewItem: pub caller sees the pub item, NOT the secret item`
- `reader: review-queue visibility (P6a) > getReviewItem: empty tags see nothing`

**Mutation C — drop tenant scoping on either reader:** remove
`eq(reviewQueue.tenantId, ctx.tenantId)`.
**Effect:** cross-tenant queue items surface.
**Expected failing tests:**
- `reader: review-queue visibility (P6a) > findPendingReviewItems: tenant B never sees tenant A items, only its own (cross-tenant)`
- `reader: review-queue visibility (P6a) > getReviewItem: tenant B cannot fetch a tenant A item even with matching tags`

(The `VulnerableGraphStoreReader` canary covers both readers — they downgrade the
context like every other reader, so a dropped-filter regression is doubly caught.
The write side — `enqueueReviewItem` lands 'pending' with zero shared effect, and
`resolveReviewItem` is tenant-scoped + idempotent against double-resolution — is
proven in `graph/review-queue.int.test.ts`.)

## Mutation 18 — a shared-graph mutation skips its audit row, or writes it out of transaction (P6a)

`updateEntity` / `updateEdge` write ONE `audit_events` row in the SAME transaction
as the mutation (mirroring `internal_bypass_log` via the shared `writeAuditEvent`).
Every shared-graph mutation is audited; a rolled-back mutation writes no audit row.

**Mutation A — drop the audit write:** remove the `writeAuditEvent` call from
`updateEntity` (or `updateEdge`).
**Effect:** a shared-graph change leaves no accountability trail — the exact DPO
requirement the audit exists for.
**Expected failing tests (`graph/audit-on-mutation.int.test.ts`):**
- `audit-on-mutation — every shared-graph mutation is audited > updateEntity writes exactly one audit_events row with a content-free change summary`
- `audit-on-mutation — every shared-graph mutation is audited > updateEdge writes exactly one audit_events row`

**Mutation B — write the audit row outside the mutation's transaction** (e.g. via
`this.db` after the `.returning()` instead of the wrapping `this.db.transaction`):
a rolled-back mutation would still leave an orphan audit row.
**Effect:** the audit trail and the graph diverge — a row asserting a change that
never committed.
**Expected failing test:**
- `audit-on-mutation … > a rolled-back updateEntity writes NO audit row (in-tx guarantee), and the entity is unchanged`

**Mutation C — put raw new VALUES in `details`:** the change summary must list
WHICH fields changed (`changedFields`), never the new values (content/PII must not
reach the audit — F4 spirit).
**Expected failing test:**
- `audit-on-mutation … > the audit details carry only the changed field NAMES, never values`

## Mutation 19 — `getEmbeddingsByTargets` drops its access filter (P2-3)

The semantic-dedup vector read returns the STORED VECTORS for requested target
ids — a dropped filter hands a caller the raw embedding of content outside
their clearance (an inversion-attack surface, OWASP LLM08). Its only
production caller passes a bypass context (`semantic-dedup.detect`), but the
method is a general reader on `GraphStoreReader` and must enforce the full
filter for any regular caller.

**Mutation A — drop the access-tag branch:** in `getEmbeddingsByTargets`,
remove the `if (ctx.kind === 'regular') { … accessTags && … }` block so only
tenant + model + targetKind + soft-delete remain.
**Effect:** a regular caller fetches stored vectors for paragraphs they cannot see.
**Expected failing tests (`permissions/permission-matrix.int.test.ts`):**
- `reader: getEmbeddingsByTargets (P2-3) > returns only embeddings whose tags the caller holds`
- `reader: getEmbeddingsByTargets (P2-3) > empty tags return nothing (fail-closed, never "no filter")`
- `CANARY — … > the vulnerable store also leaks a secret stored vector via getEmbeddingsByTargets (P2-3)`

**Mutation B — drop tenant scoping:** remove `eq(embeddings.tenantId, ctx.tenantId)`.
**Effect:** cross-tenant vectors surface by id.
**Expected failing tests:**
- `reader: getEmbeddingsByTargets (P2-3) > does not return another tenant's embeddings (even passing its ids)`
- `reader: getEmbeddingsByTargets (P2-3) > bypass sees both embeddings (tenant still enforced) and writes a log row` (the cross-tenant arm)

**Mutation C — drop the paragraph soft-delete join clause:** remove the
`targetKind <> 'paragraph' OR paragraphs.deletedAt IS NULL` predicate.
**Effect:** vectors of soft-deleted (e.g. superseded/withdrawn) content stay readable.
**Expected failing test:**
- `reader: getEmbeddingsByTargets (P2-3) > a soft-deleted paragraph's embedding is excluded`

---

## How to update this document

Whenever you add a new permission-related code path:

1. Identify the most plausible mutation that would weaken it.
2. Add a section above following the same format.
3. Confirm the test that catches it.
4. If no existing test catches it, write one in `graph-store.int.test.ts` first, then come back here.

Whenever you remove or restructure a code path:

1. Update the sections that referenced the removed code.
2. Verify the remaining mutations still produce the expected failures.

This document is reviewed alongside any PR that touches `postgres-graph-store.ts` or the `_common.ts` column helpers.
