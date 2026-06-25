// Configuration schema for Munin.
//
// This file defines the *shape* of a configuration. The engine consumes
// configurations through these types; it does not know any vertical concepts.
// See `decisions.md` in this package for the design rationale.

// ---------------------------------------------------------------------------
// JSON Schema subset
// ---------------------------------------------------------------------------
//
// We define our own minimal JSON-Schema-compatible union rather than depending
// on a third-party JSON Schema library. The subset is intentionally small —
// it covers what an LLM can usefully extract and what the UI can usefully
// render. Adding new variants is a deliberate schema-evolution decision.

export type JsonSchema =
  | JsonStringSchema
  | JsonNumberSchema
  | JsonBooleanSchema
  | JsonArraySchema
  | JsonObjectSchema;

export interface JsonStringSchema {
  readonly type: 'string';
  readonly description?: string;
  readonly format?: 'date' | 'date-time' | 'email' | 'uri';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly enum?: readonly string[];
}

export interface JsonNumberSchema {
  readonly type: 'number';
  readonly description?: string;
  readonly integer?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface JsonBooleanSchema {
  readonly type: 'boolean';
  readonly description?: string;
}

export interface JsonArraySchema {
  readonly type: 'array';
  readonly description?: string;
  readonly items: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface JsonObjectSchema {
  readonly type: 'object';
  readonly description?: string;
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties?: boolean;
}

// ---------------------------------------------------------------------------
// Few-shot examples
// ---------------------------------------------------------------------------
//
// A few-shot example pairs a paragraph (input) with the entities and
// relationships expected to be extracted (output). Ordering of `fewShots`
// arrays is preserved verbatim in the assembled extraction prompt and
// participates in the schema hash. No re-sorting at load time.

export interface FewShotExample {
  readonly input: string;
  readonly output: ExtractionExpectation;
}

export interface ExtractionExpectation {
  readonly entities: ReadonlyArray<ExpectedEntity>;
  readonly relationships?: ReadonlyArray<ExpectedRelationship>;
}

export interface ExpectedEntity {
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
  // Optional character span in the source paragraph. Useful for evaluation;
  // not required for the LLM to produce.
  readonly mentionSpan?: readonly [number, number];
}

export interface ExpectedRelationship {
  readonly type: string;
  // Indexes into the `entities` array of the same example.
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly properties?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Entity and relationship types
// ---------------------------------------------------------------------------
//
// An entity type is an opaque named bundle: name + description + property
// schema + few-shots. The engine never matches on the name; the configuration
// supplies meaning. A relationship type connects entities by listing valid
// source and target type names.

// Query-time entity-resolution hints (M1.1). GENERIC mechanism — the engine
// clusters on property/embedding/graph similarity; this hook supplies the
// vertical-specific refinement WITHOUT the engine knowing any vertical concept
// (Rule 1). Every field is optional. Resolution is query-time only: these hints
// live in `compositeHash`, NEVER `schemaHash` — they must not invalidate the
// extraction prompt cache (verified: computeSchemaHash projects only
// name/description/propertySchema/fewShots).
export interface EntityResolutionHints {
  // Property/properties holding the entity's human identity, name-form aware
  // (e.g. ['fullName']). The resolver normalises + compares these to generate
  // merge candidates.
  readonly identityProperties?: readonly string[];
  // Properties forming an EXACT natural key: when all are present and equal
  // across two rows, they are confidently the same entity (e.g. two id columns
  // that together form a unique key) — a non-context path to a confident merge.
  readonly exactKeyProperties?: readonly string[];
  // Properties that, when present and DIFFERENT across two candidates, BLOCK a
  // merge (positive evidence of distinct entities).
  readonly distinguishingProperties?: readonly string[];
  // Per-exact-key-property validation pattern (regex source). A value bound to an
  // exact-key property is treated as a valid identity key ONLY if it matches the
  // pattern; a value that fails — e.g. a case/document reference mistakenly grabbed
  // as a person's ref — is IGNORED for identity (the entity is kept, just keyless),
  // never used to force a confident merge. GENERIC: the engine knows only that the
  // property HAS a pattern; the pattern's meaning is the configuration's (Rule 1).
  readonly exactKeyPatterns?: Readonly<Record<string, string>>;
}

export interface EntityTypeDefinition {
  readonly name: string;
  readonly description: string;
  readonly propertySchema: JsonObjectSchema;
  readonly fewShots: readonly FewShotExample[];
  // Query-time resolution hints (M1.1). Optional; compositeHash-only (see above).
  readonly resolution?: EntityResolutionHints;
}

export interface RelationshipTypeDefinition {
  readonly name: string;
  readonly description: string;
  readonly fromTypes: readonly string[];
  readonly toTypes: readonly string[];
  readonly propertySchema?: JsonObjectSchema;
  readonly fewShots?: readonly FewShotExample[];
}

// ---------------------------------------------------------------------------
// Cosmetic items: terminology, roles, tag expansion, query templates
// ---------------------------------------------------------------------------

export type TerminologyMap = Readonly<Record<string, string>>;

export interface RoleDefinition {
  readonly name: string;
  readonly description: string;
  // Base access tags the role grants. Hierarchical expansion happens via
  // `Configuration.tagExpansion`, which the configuration layer owns. The
  // engine consumes only the final expanded flat array.
  readonly baseTags: readonly string[];
  // Generic, vertical-agnostic capabilities this role grants beyond read access
  // (e.g. reaching the admin console, reviewing proposed corrections). Opaque
  // strings the engine never interprets; surfaces decide what a capability gates.
  // Optional → none. The defined vocabulary is small and deliberate — add a
  // capability only when a real consumer lands (see the consts below).
  readonly capabilities?: readonly string[];
}

// The tenant-admin capability (session 2.7): its holder may reach the admin
// console and perform tenant-admin actions (manage role bindings, set caps). A
// user is an admin iff any resolved configuration role carries this capability —
// there is no hardcoded "admin" role NAME anywhere in engine/web logic.
export const MANAGE_TENANT = 'manageTenant';

// The correction-review (steward) capability (P6a): its holder may VERIFY a
// proposed correction — apply it to the shared graph — and reject the rest. Any
// authenticated user may SUGGEST a correction (it lands in the review queue with
// no shared effect); only a steward may approve. This is the genuine second
// consumer the comment above MANAGE_TENANT was waiting for: it is independent of
// MANAGE_TENANT (a tenant can appoint stewards who are not admins, or — in the
// pilot — map one person to both). The engine never interprets it; isSteward /
// requireSteward in the web layer decide what it gates, exactly like isAdmin.
export const REVIEW_CORRECTIONS = 'reviewCorrections';

// A node in a tenant's organisational tree (D3). Vertical-agnostic by
// construction: `kind` is an opaque string the engine never interprets (a
// configuration decides that `kind: 'office'` sits under `kind: 'org'`).
// `tags` are the access tags this unit grants. The per-tenant tree instance is
// stored in the operational-metadata store and handed to the TagExpander via
// the context below, so configuration logic + per-tenant data meet in one place
// (decisions.md Decision 5: "the function may consult tenant metadata").
export interface OrgUnit {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly label: string;
  readonly tags?: readonly string[];
}

export interface TagExpansionContext {
  readonly tenantId: string;
  // Optional per-tenant org-unit snapshot for hierarchical expansion. Absent
  // for flat configurations (e.g. generic-demo, HR institutional-only); the
  // engine passes it through opaquely from the operational store.
  readonly orgUnits?: readonly OrgUnit[];
}

// A configuration-supplied function that turns a user's base tag set into the
// fully expanded set the engine will use for filtering. The engine knows
// nothing about hierarchy; the configuration enumerates (optionally consulting
// the per-tenant `orgUnits` snapshot).
export type TagExpander = (
  baseTags: readonly string[],
  context: TagExpansionContext,
) => Promise<readonly string[]> | readonly string[];

// The WRITE-SIDE counterpart of `TagExpander`: a configuration-supplied function
// that composes the access tags a freshly-uploaded document is stamped with for a
// chosen sensitivity class. The scope×capability fusion convention lives in the
// configuration, never in the engine or web (Rule 1) — the web upload route sources
// this composer from the loaded `Configuration` rather than naming a vertical. It
// returns [] for an unknown/absent class so the upload route fails closed.
export interface WriteTagInput {
  // The picked sensitivity class id, or null/undefined when none was selected.
  readonly classId: string | null | undefined;
  // The uploader's bare SCOPE tags (org-unit scope) for write-time fusion; empty
  // in a flat (no org tree) configuration.
  readonly scopeTags: readonly string[];
}
export type WriteTagComposer = (input: WriteTagInput) => readonly string[];

export interface SlotDefinition {
  readonly kind: 'entityRef' | 'dateRange' | 'text' | 'enum';
  readonly required: boolean;
  readonly description?: string;
  // For kind === 'entityRef'.
  readonly entityTypes?: readonly string[];
  // For kind === 'enum'.
  readonly values?: readonly string[];
}

// An expansion plan is a structural query — *not* a natural-language prompt.
// The engine executes it deterministically against the graph. Adding a new
// template never requires engine changes; the plan grammar does.
export interface ExpansionPlan {
  readonly startSlot: string;
  readonly traverse?: readonly TraverseStep[];
  readonly filterByDate?: {
    readonly slot: string;
    readonly field: string;
  };
  readonly resultLimit?: number;
}

export interface TraverseStep {
  readonly edgeTypes: readonly string[];
  readonly direction: 'out' | 'in' | 'both';
  readonly maxDepth: number;
}

export interface QueryTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly slots: Readonly<Record<string, SlotDefinition>>;
  readonly expansion: ExpansionPlan;
}

// ---------------------------------------------------------------------------
// Document templates (M2.2) — a GENERATION program, distinct from QueryTemplate
// (the retrieval grammar). A DocumentTemplate describes a document about ONE
// subject entity: ordered sections, each with a fill-source. The engine
// executor composes (template + the subject's gathered records + user-supplied
// slot values) into a grounded, structured document — reusing the M2.1
// generation core for the auto sections.
//
// VERTICAL-AGNOSTIC: the grammar (formats, fill kinds) is engine; "what an HR
// case summary is" (the sections, instructions, subjectEntityType) is config.
// compositeHash, NOT schemaHash — generation-time config never affects extraction.
// ---------------------------------------------------------------------------
export type DocumentSectionFormat = 'prose' | 'list' | 'field';

// How a section's content is produced:
//   • auto-from-gather — SYNTHESISED from the gathered records, grounded +
//     cited per-claim (M2.1). The Munin-asserted facts.
//   • asked-of-user — a value the human supplies (reuses SlotDefinition). The
//     human's own input, not a Munin fact-claim.
//   • static — verbatim boilerplate authored in the template. Not a Munin
//     fact-claim.
// The executor keeps these provenance classes DISTINCT in its output so the
// workspace (M2.3) can render Munin-asserted (cited) content visibly apart from
// boilerplate / user input.
export type FillSource =
  | { readonly kind: 'auto-from-gather'; readonly instruction: string }
  | { readonly kind: 'asked-of-user'; readonly slot: SlotDefinition }
  | { readonly kind: 'static'; readonly text: string };

export interface DocumentSection {
  readonly heading: string;
  readonly format: DocumentSectionFormat;
  readonly fill: FillSource;
}

export interface DocumentTemplate {
  readonly id: string;
  readonly title: string;
  // The OPAQUE entity type this document is about — config names it; the engine
  // does not. The executor gathers this entity's records (M1.2).
  readonly subjectEntityType: string;
  readonly sections: readonly DocumentSection[];
}

// ---------------------------------------------------------------------------
// Connector binding
// ---------------------------------------------------------------------------
//
// A configuration declares which connectors a vertical uses by package name,
// and the shape of each connector's per-tenant configuration. Concrete
// per-tenant values (secrets, paths, credentials) are supplied separately at
// runtime by the hosting infrastructure — never committed to a configuration
// package.

export interface ConnectorBinding {
  readonly packageName: string;
  readonly description: string;
  readonly perTenantConfigSchema: JsonObjectSchema;
}

// OPAQUE authority ordering for P3b contradiction adjudication.
//
// When two cited sources materially DISAGREE, the engine must DETERMINISTICALLY
// flag which side is the current/authoritative one — never an LLM judgement.
// Authority is decided HERE, in configuration: the engine treats each entry as
// an OPAQUE access-tag token and never interprets what makes a source
// authoritative (Rule 1 — the engine knows nothing of trusts, policies, or any
// domain notion of authority). A document's authority rank is the index of the
// FIRST token in `orderedTags` present in that document's access tags (lower
// index = more authoritative); a document matching no token ranks below all
// matched ones. Recency/validity (document version supersession + the document's
// real-world `sourceModifiedAt`) breaks ties — and is the SOLE adjudication
// signal when no authority policy is supplied. Most configurations ship none.
export interface AuthorityPolicy {
  // Opaque access-tag tokens, most-authoritative first. Matched against a
  // document's access tags by exact membership; the engine never parses them.
  readonly orderedTags: readonly string[];
}

// Recommended query-pipeline retrieval defaults for this configuration.
//
// Retrieval is corpus-sensitive: the engine's built-in defaults are tuned for
// natural-language business documents, but dense, terse, or long-form text
// (e.g. legislation) retrieves better with a looser cosine cutoff and a larger
// top-k. A configuration can ship recommended values here; the query layer
// applies them as the baseline, still overridable per call. These are purely
// caller-level retrieval knobs — they do NOT affect extraction or the schema
// hash. Every field is optional; an unset field falls back to the engine
// default. (F-L1, surfaced by the legislation stress test.)
export interface QueryDefaults {
  // Vector search breadth (top-k).
  readonly k?: number;
  // Max paragraphs admitted to the grounding prompt.
  readonly maxParagraphs?: number;
  // Cosine-distance cutoff for vector hits (higher = more permissive).
  readonly distanceThreshold?: number;
  // Token ceiling for the grounding sources.
  readonly tokenCeiling?: number;
  // Per-entity neighbour cap during graph expansion.
  readonly expansionBreadth?: number;
  // Hybrid retrieval blend weight on the keyword/lexical path (open question
  // path): 0 = vector-only, 1 = keyword-only. Engine default ≈0.4 (≈60/40
  // semantic/keyword). Tune per vertical — proper-noun/exact-term-heavy corpora
  // (legislation, codes/refs) benefit from a higher keyword weight.
  readonly keywordWeight?: number;
  // Keyword search breadth (top-k for the lexical path). Defaults to `k`.
  readonly keywordK?: number;
  // How many retrieved candidates the reranker (when enabled) re-scores. The
  // reranker can only promote a document it actually sees, so at scale this must
  // cover the candidate pool (≈`k`/`keywordK`) — otherwise the answer document,
  // ranked below the cutoff by the noisy hybrid order, is never reranked and stays
  // out of the grounded set. Engine default 60. Larger = better scale recall, at
  // a higher per-query rerank cost.
  readonly rerankCandidates?: number;
  // Recency decay half-life in days for the open ranking path: older paragraphs
  // decay toward a floor so current documents outrank stale ones (superseded
  // policies, old term dates) — a SOFT signal that never makes old material
  // unreachable. Engine default OFF (undefined). Tune per vertical: fast decay
  // for HR/policies (e.g. ~365), slow or off for legislation/precedent.
  readonly recencyHalfLifeDays?: number;
  // Multiplier applied to the open-path ranking score of paragraphs belonging to
  // a SUPERSEDED document version (validTo set), so the current version outranks
  // its superseded predecessors — a SOFT demotion that never DROPS the old
  // version (it stays retrievable, just lower). In [0,1]; 1 disables the demote,
  // < 1 demotes (engine default 0.5). Generic: the engine demotes by
  // validity/supersession only, never a domain concept.
  readonly supersededDemotionFactor?: number;
  // OPAQUE authority ordering for the P3b "sources disagree" pass. When the
  // cited sources behind an answer materially conflict, the engine flags the
  // current/authoritative side by this ordering (then recency/validity). Absent
  // ⇒ adjudicate by recency/validity alone. See AuthorityPolicy. Opaque to the
  // engine; ships no domain meaning.
  readonly authorityPolicy?: AuthorityPolicy;
  // Toggle the P3b "sources disagree" contradiction pass on the answer path.
  // Default ON — a configuration omitting it gets contradiction detection. Set
  // false to suppress the extra (cheap, Haiku) detection call for a vertical
  // that does not want disagreement surfaced. Affects neither the grounded
  // answer text nor the fail-closed path (the pass is purely additive).
  readonly contradictionDetection?: boolean;
}

// ---------------------------------------------------------------------------
// Configuration and overlay
// ---------------------------------------------------------------------------

// Sensitivity class — generic, configuration-supplied marker that travels with
// every document touch-point on the web (search row, viewer header, source-
// pane header, citation hover-card, access-audit drilldown, ingestion access
// preview, and the .md download header). The engine does NOT consult this —
// it is a purely cosmetic + ingestion-default surface. Authoritative
// permission lives in access tags as usual. Each class has a short id (stable
// programmatic key), a human name, a scope sentence, and a `restricted` flag
// that controls badge styling (oxblood when restricted; muted/hairline when
// open). Optional `m365Group` documents the group that grants the underlying
// tag, for the ingestion access preview.
//
// Generic, vertical-agnostic in shape. Vertical strings (HR confidential,
// org-wide, etc.) live in the configuration that ships the values
// (a vertical configuration supplies its own list).
export interface SensitivityClass {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly restricted: boolean;
  // True iff this class WIDENS access (org-wide / office-wide in HR's set).
  // Drives the warn-amber "widens access" badge on the ingestion preview.
  readonly widensAccess?: boolean;
  // The default class selected at ingestion when this configuration is
  // active. At most one class per configuration should set this; the loader
  // does not enforce uniqueness (last-write-wins via Array.find).
  readonly isDefault?: boolean;
  // Cosmetic M365 group label shown on the ingestion access preview. Optional;
  // when absent the ingestion preview omits the per-group hint for that class.
  readonly m365Group?: string;
  // OPTIONAL access-tag mapping (F33). The web's per-document badge derivation
  // (lib/sensitivity.ts:classifyDocumentSensitivity) classifies a document as
  // belonging to THIS class when the document's access_tags include ANY of
  // these strings. Most-restrictive wins when more than one class matches
  // (restricted=true beats restricted=false; ties broken by config order, so
  // a configuration can encode preference by listing the more-protective
  // class first). Engine stores the access tags; the LABELS — including this
  // tag → class mapping — live in configuration. A class that omits
  // accessTags is never matched by a document's tags; it'll only ever be the
  // configuration default (if isDefault) or the explicit picker selection.
  readonly accessTags?: readonly string[];
}

export interface Configuration {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly entityTypes: readonly EntityTypeDefinition[];
  readonly relationshipTypes: readonly RelationshipTypeDefinition[];
  readonly terminology: TerminologyMap;
  readonly roles: readonly RoleDefinition[];
  readonly tagExpansion: TagExpander;
  readonly queryTemplates: readonly QueryTemplate[];
  readonly connectors: readonly ConnectorBinding[];
  // Optional recommended query-pipeline retrieval defaults (F-L1). Absent on
  // most configurations; the engine defaults apply when unset.
  readonly queryDefaults?: QueryDefaults;
  // Optional generation programs (M2.2). Absent on most configurations.
  // compositeHash, never schemaHash.
  readonly documentTemplates?: readonly DocumentTemplate[];
  // Optional sensitivity classes for the web's SensitivityBadge + ingestion
  // default-deny default. Generic — vertical strings come from the
  // configuration that supplies the list. The engine does not consult these;
  // permission lives in access tags.
  readonly sensitivityClasses?: readonly SensitivityClass[];
  // The write-side tag composer for `sensitivityClasses` (the counterpart of
  // `tagExpansion`). The web upload route calls this to stamp a document's access
  // tags for the picked class, sourcing the scope×capability convention from the
  // loaded configuration — so the web never embeds a vertical tag convention or
  // names a specific config package (Rule 1). A configuration shipping
  // `sensitivityClasses` for upload should also ship this composer.
  readonly composeWriteTags?: WriteTagComposer;
}

// Overlay: tenant-level modifications.
//
// Extension-only on extraction schema:
//   - add new entity types
//   - extend existing entity types by adding properties / few-shots
//   - add new relationship types
//
// Full override allowed on cosmetic items:
//   - terminology entries (per-key last-write-wins)
//   - role definitions (per-name last-write-wins)
//   - tag expansion (whole function replaced)
//   - query templates (per-id last-write-wins)
//   - connector bindings (per-packageName last-write-wins)
//
// Removing or redefining an existing entity type or relationship type via
// overlay is *not* permitted. Composition throws.

export interface Overlay {
  readonly id: string;
  readonly version: string;
  readonly baseConfigurationId: string;

  // Extension-only on extraction schema.
  readonly addEntityTypes?: readonly EntityTypeDefinition[];
  readonly extendEntityTypes?: readonly EntityTypeExtension[];
  readonly addRelationshipTypes?: readonly RelationshipTypeDefinition[];

  // Full override on cosmetic items.
  readonly terminology?: TerminologyMap;
  readonly roles?: readonly RoleDefinition[];
  readonly tagExpansion?: TagExpander;
  readonly queryTemplates?: readonly QueryTemplate[];
  readonly connectors?: readonly ConnectorBinding[];
  readonly documentTemplates?: readonly DocumentTemplate[];
}

export interface EntityTypeExtension {
  readonly name: string;
  readonly addProperties: Readonly<Record<string, JsonSchema>>;
  readonly addRequired?: readonly string[];
  readonly addFewShots?: readonly FewShotExample[];
}

// Result of composing a base configuration with zero or more overlays.
//
// - schemaHash    hashes only the extraction-affecting parts. Used as the
//                 Bedrock prompt-cache key component, and recorded against
//                 every extracted fact so cache invalidation is clean when
//                 the schema changes.
// - compositeHash hashes the whole effective configuration including
//                 cosmetic items and applied overlay ids. Used for cache
//                 invalidation on UI/role changes (cheap), without
//                 invalidating extraction caches.
export interface ComposedConfiguration extends Configuration {
  readonly schemaHash: string;
  readonly compositeHash: string;
  readonly appliedOverlays: readonly string[];
}
