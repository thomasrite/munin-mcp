// LearningStore — the per-(tenant, actor) learning-metadata adapter (P5a).
//
// This is the storage adapter for the three learning tables (generation_feedback,
// learned_rules, style_profiles). It is SEPARATE from the GraphStore on purpose:
// these are NOT graph facts. They carry no access_tags and never go through the
// access-tag read path. Their isolation boundary is the (tenant_id, actor) pair —
// EVERY read and write below filters on BOTH, so one actor's rows can never reach
// another and one tenant's can never reach another.
//
// GENERIC / vertical-agnostic: rule_text / rule_key / profile_text / the feedback
// content are OPAQUE — stored and returned verbatim, never interpreted, naming no
// vertical concept. No provider SDK is imported here; the embedding arrives as a
// plain number[] the caller produced via the EmbeddingProvider.
//
// FOUR ENFORCED INVARIANTS:
//   • SCOPE-LOCKED — every NON-gated write (recordFeedback / insertRule /
//     upsertStyleProfile) asserts scope === 'personal'. A SHARED rule is created
//     ONLY by the gated writeSharedRule, which is intended to be called from the
//     steward-approved review-queue promotion (P5b) — never from the open paths.
//   • PROVENANCE-GATED — insertRule AND writeSharedRule require a sourceFeedbackId
//     (the column is NOT NULL FK'd): no rule without the signal it came from. A
//     promoted shared rule inherits the promoted personal rule's sourceFeedbackId.
//   • DEDUP-REINFORCE — before inserting a rule, its embedding is cosine-compared
//     to existing rules of the same scope (personal: the actor's; shared: the
//     tenant's); ≥ 0.92 to one → reinforce it (bump reinforcement_count +
//     confidence + updated_at) instead of inserting a duplicate.
//   • OWNERSHIP-CHECKED (F56) — caller-supplied cross-references are verified,
//     never trusted: insertRule requires the sourceFeedbackId to be the actor's
//     own feedback; writeSharedRule requires it to be THIS tenant's feedback
//     (proposer ≠ approving steward, so tenant-scoped only); linkFeedbackRule
//     requires the rule id to belong to the same (tenant, actor).
//
// Mirrors PostgresGraphStore's dual-driver handling: the same SQL runs on hosted
// node-postgres AND on PGlite (local/desktop), so behaviour is identical on both.

import { type SQL, and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { generationFeedback, learnedRules, styleProfiles } from '../db/schema';
import { EMBEDDING_DIMENSIONS } from '../db/schema/embeddings';
import { type ActorId, type TenantId, asActorId, asTenantId } from '../graph/types';

import {
  LearningOwnershipError,
  LearningProvenanceError,
  LearningRuleBoundsError,
  LearningScopeError,
  LearningStoreError,
} from './errors';
import type {
  FeedbackContext,
  FeedbackDecision,
  GenerationFeedback,
  InsertRuleInput,
  InsertRuleResult,
  LearnedRule,
  LearningContext,
  LearningScope,
  RecordFeedbackInput,
  StyleProfile,
  WriteSharedRuleInput,
} from './types';

// Near-duplicate threshold: cosine similarity ≥ this → reinforce, don't duplicate.
// pgvector's `<=>` returns cosine DISTANCE, so similarity = 1 - distance.
export const RULE_DEDUP_SIMILARITY = 0.92;

// Deterministic rule-text bounds (G2a/P2-1), enforced at BOTH write paths
// (insertRule + writeSharedRule). A learned rule is one short style
// preference; anything longer is either a content leak or prompt bloat. The
// numbers are generous for a one-liner and tiny against the injection budget.
// Chars are UTF-16 code units (String.length) — the same unit the web budget
// counts, so the slate-fits-budget invariant holds for any content.
export const RULE_TEXT_MAX_CHARS = 500;
export const RULE_TEXT_MAX_LINES = 3;

// Internal query handle — narrowed to one concrete driver shape (mirrors
// PostgresGraphStore). Both supported drivers expose the identical Drizzle API.
type Db = PostgresJsDatabase | Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

// Public constructor input: hosted node-postgres OR the local PGlite driver.
type LearningStoreDb =
  | PostgresJsDatabase
  | Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0]
  | PgliteDatabase
  | Parameters<Parameters<PgliteDatabase['transaction']>[0]>[0];

export class LearningStore {
  private readonly db: Db;

  constructor(db: LearningStoreDb) {
    // Both drivers implement the same Drizzle query API at runtime; narrowing here
    // is a compile-time convenience with no runtime effect (see PostgresGraphStore).
    this.db = db as Db;
  }

  static fromConnectionString(
    url: string,
    options?: postgres.Options<Record<string, never>>,
  ): { store: LearningStore; close: () => Promise<void> } {
    const client = postgres(url, options);
    const db = drizzle(client);
    return { store: new LearningStore(db), close: () => client.end({ timeout: 5 }) };
  }

  // -------------------------------------------------------------------------
  // generation_feedback
  // -------------------------------------------------------------------------

  /** Record one (draft → human-final) signal for this actor. */
  async recordFeedback(
    ctx: LearningContext,
    input: RecordFeedbackInput,
  ): Promise<GenerationFeedback> {
    assertPersonal(input.scope);
    const rows = await this.db
      .insert(generationFeedback)
      .values({
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        // reason: strips Readonly for Drizzle's mutable jsonb param; opaque either way.
        context: input.context as Record<string, unknown>,
        modelDraft: input.modelDraft,
        humanFinal: input.humanFinal,
        decision: input.decision,
        scope: input.scope,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new LearningStoreError('recordFeedback returned no row');
    return feedbackFromRow(row);
  }

  /**
   * Link a feedback row to the rule inferred from it (and record the inference
   * confidence). Tenant + actor scoped, so an actor can only annotate their own
   * feedback.
   */
  async linkFeedbackRule(
    ctx: LearningContext,
    feedbackId: string,
    rule: { readonly ruleId: string; readonly confidence: number },
  ): Promise<void> {
    // Defence in depth (F56 sibling): inferred_rule_id carries no FK, so the rule
    // id would be recorded verbatim — verify it is the caller's own PERSONAL rule
    // (same tenant + actor; inferredRuleId means "the personal rule inferred from
    // this feedback", never a shared one). Check-then-update is not transactional;
    // the one rule-delete path (eraseActorLearningData, G2a) makes a lost race
    // possible but benign: it would leave a dangling content-free uuid on a
    // feedback row the same erasure deletes or scrubs (inferred_rule_id → NULL).
    const owned = await this.db
      .select({ id: learnedRules.id })
      .from(learnedRules)
      .where(
        and(
          eq(learnedRules.tenantId, ctx.tenantId),
          eq(learnedRules.actor, ctx.actor),
          eq(learnedRules.scope, 'personal'),
          eq(learnedRules.id, rule.ruleId),
        ),
      )
      .limit(1);
    if (!owned[0]) {
      throw new LearningOwnershipError(
        `rule ${rule.ruleId} does not belong to this (tenant, actor)`,
      );
    }
    await this.db
      .update(generationFeedback)
      .set({ inferredRuleId: rule.ruleId, confidence: rule.confidence })
      .where(
        and(
          eq(generationFeedback.tenantId, ctx.tenantId),
          eq(generationFeedback.actor, ctx.actor),
          eq(generationFeedback.id, feedbackId),
        ),
      );
  }

  /**
   * Retention sweep (F55): scrub the CONTENT of feedback rows older than `cutoff`
   * IN PLACE — model_draft/human_final → NULL, content_scrubbed_at stamped — while
   * the row skeleton (decision/context/scope metadata + any rule linkage) survives
   * for provenance. The learned_rules.source_feedback_id FK (ON DELETE restrict)
   * makes scrub-in-place the only legal retention move for a referenced row; the
   * same move is applied to every expired row so retention never depends on
   * reference order. Idempotent: content_scrubbed_at is the marker — an
   * already-scrubbed row never matches again.
   *
   * TENANT-SCOPED SYSTEM MAINTENANCE — deliberately not actor-scoped (it sweeps
   * every actor's expired rows in the tenant), and deliberately NO internalBypass:
   * the learning tables carry no access_tags, so there is no access filter to
   * bypass — tenant isolation is the only boundary here and it is preserved.
   * Returns the number of rows scrubbed (a content-free count for the audit row
   * the calling sweep writes).
   */
  async scrubExpiredFeedbackContent(tenantId: TenantId, cutoff: Date): Promise<number> {
    const rows = await this.db
      .update(generationFeedback)
      .set({ modelDraft: null, humanFinal: null, contentScrubbedAt: new Date() })
      .where(
        and(
          eq(generationFeedback.tenantId, tenantId),
          lt(generationFeedback.createdAt, cutoff),
          isNull(generationFeedback.contentScrubbedAt),
        ),
      )
      .returning({ id: generationFeedback.id });
    return rows.length;
  }

  /**
   * DSAR erasure of ONE actor's learning data (F55) — the learning-table half of
   * the eraseActorLearning orchestrator (erasure/erase-actor-learning.ts), which
   * is the intended caller and supplies the transaction: THIS METHOD DOES NOT
   * OPEN ONE — construct the store over a tx handle (as the orchestrator does)
   * or the multi-statement erasure is not atomic.
   *
   * The delete/scrub split:
   *   • personal learned_rules — DELETED (first: their NOT NULL FK to feedback
   *     would otherwise block the feedback deletes below). Ids returned so the
   *     caller can sweep pending review-queue promotions of these rules.
   *   • style_profiles — DELETED (always derived; rebuilt from future rules).
   *   • generation_feedback referenced by a SHARED rule — SCRUBBED, not deleted:
   *     a steward-approved promotion made the rule company property, and its
   *     provenance pointer (source_feedback_id, FK ON DELETE restrict) must keep
   *     resolving. Content is NULLed + content_scrubbed_at stamped (preserved if
   *     already set); inferred_rule_id is NULLed too — it pointed at the personal
   *     rule deleted above and would dangle.
   *   • all other generation_feedback of the actor — DELETED.
   *
   * Tenant + target-actor scoped on every statement; no internalBypass (no
   * access_tags on these tables — see scrubExpiredFeedbackContent). Returns
   * content-free counts + the deleted personal-rule ids.
   */
  async eraseActorLearningData(
    tenantId: TenantId,
    erasedActor: ActorId,
  ): Promise<{
    readonly deletedRuleIds: readonly string[];
    readonly personalRulesDeleted: number;
    readonly styleProfilesDeleted: number;
    readonly feedbackDeleted: number;
    readonly feedbackScrubbed: number;
  }> {
    const deletedRules = await this.db
      .delete(learnedRules)
      .where(
        and(
          eq(learnedRules.tenantId, tenantId),
          eq(learnedRules.actor, erasedActor),
          eq(learnedRules.scope, 'personal'),
        ),
      )
      .returning({ id: learnedRules.id });

    const deletedProfiles = await this.db
      .delete(styleProfiles)
      .where(and(eq(styleProfiles.tenantId, tenantId), eq(styleProfiles.actor, erasedActor)))
      .returning({ id: styleProfiles.id });

    // The actor's feedback rows a SHARED rule still references (a personal rule
    // can only reference its owner's feedback — F56 — so after the delete above,
    // shared rules are the only remaining referencers).
    const sharedRef = await this.db
      .selectDistinct({ id: generationFeedback.id })
      .from(generationFeedback)
      .innerJoin(learnedRules, eq(learnedRules.sourceFeedbackId, generationFeedback.id))
      .where(
        and(
          eq(generationFeedback.tenantId, tenantId),
          eq(generationFeedback.actor, erasedActor),
          eq(learnedRules.tenantId, tenantId),
          eq(learnedRules.scope, 'shared'),
        ),
      );
    const sharedRefIds = sharedRef.map((r) => r.id);

    let feedbackScrubbed = 0;
    if (sharedRefIds.length > 0) {
      const scrubbed = await this.db
        .update(generationFeedback)
        .set({
          modelDraft: null,
          humanFinal: null,
          // The inferred personal rule was deleted above — NULL the pointer and
          // its inference confidence together rather than leaving half a link.
          inferredRuleId: null,
          confidence: null,
          // Keep an earlier retention-sweep stamp if one exists — the marker
          // records when content FIRST left the row.
          contentScrubbedAt: sql`COALESCE(${generationFeedback.contentScrubbedAt}, now())`,
        })
        .where(
          and(
            eq(generationFeedback.tenantId, tenantId),
            eq(generationFeedback.actor, erasedActor),
            inArray(generationFeedback.id, sharedRefIds),
          ),
        )
        .returning({ id: generationFeedback.id });
      feedbackScrubbed = scrubbed.length;
    }

    const deletedFeedback = await this.db
      .delete(generationFeedback)
      .where(
        and(
          eq(generationFeedback.tenantId, tenantId),
          eq(generationFeedback.actor, erasedActor),
          // Spare the scrubbed, shared-referenced rows (the FK would refuse
          // anyway — this keeps the intent explicit and the error path quiet).
          ...(sharedRefIds.length > 0 ? [notInArray(generationFeedback.id, sharedRefIds)] : []),
        ),
      )
      .returning({ id: generationFeedback.id });

    return {
      deletedRuleIds: deletedRules.map((r) => r.id),
      personalRulesDeleted: deletedRules.length,
      styleProfilesDeleted: deletedProfiles.length,
      feedbackDeleted: deletedFeedback.length,
      feedbackScrubbed,
    };
  }

  /** List this actor's feedback, newest first. Primarily for tests / inspection. */
  async listFeedback(ctx: LearningContext): Promise<GenerationFeedback[]> {
    const rows = await this.db
      .select()
      .from(generationFeedback)
      .where(
        and(eq(generationFeedback.tenantId, ctx.tenantId), eq(generationFeedback.actor, ctx.actor)),
      )
      .orderBy(desc(generationFeedback.createdAt));
    return rows.map(feedbackFromRow);
  }

  // -------------------------------------------------------------------------
  // learned_rules
  // -------------------------------------------------------------------------

  /**
   * Insert a learned rule for this actor — scope-locked, provenance-gated, and
   * dedup-reinforcing. If the embedding is cosine-similar (≥ RULE_DEDUP_SIMILARITY)
   * to an existing personal rule of this actor, that rule is REINFORCED (no second
   * row); otherwise a new row is inserted.
   *
   * The probe + write run in ONE transaction, so each call's insert/reinforce is
   * atomic (all-or-nothing). It is NOT serialised against a concurrent caller:
   * under READ COMMITTED two near-simultaneous captures for the same (tenant,
   * actor) could each see no near-duplicate and both insert, yielding two
   * near-duplicate rows. That is deliberately tolerated here — the per-(tenant,
   * actor) capture rate is low, and the read side self-heals (resolveConflicts +
   * the decayed-score budget collapse near-duplicates at injection time). If
   * strict write-time dedup is ever needed, add a row lock / advisory lock keyed
   * on (tenant, actor) around the probe.
   */
  async insertRule(ctx: LearningContext, input: InsertRuleInput): Promise<InsertRuleResult> {
    assertPersonal(input.scope);
    if (!input.sourceFeedbackId || input.sourceFeedbackId.trim() === '') {
      throw new LearningProvenanceError();
    }
    assertRuleTextBounds(input.ruleText);
    if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new LearningStoreError(
        `embedding must be ${EMBEDDING_DIMENSIONS}-dim, got ${input.embedding.length}`,
      );
    }
    const literal = `[${input.embedding.join(',')}]`;
    const distance: SQL<number> = sql<number>`${learnedRules.embedding} <=> ${literal}::vector`;

    return this.db.transaction(async (tx) => {
      // Ownership gate (F56 sibling, actor-scoped): a personal rule's provenance
      // must be the actor's OWN feedback — the FK alone only proves the row
      // exists in some tenant.
      const fb = await tx
        .select({ id: generationFeedback.id })
        .from(generationFeedback)
        .where(
          and(
            eq(generationFeedback.tenantId, ctx.tenantId),
            eq(generationFeedback.actor, ctx.actor),
            eq(generationFeedback.id, input.sourceFeedbackId),
          ),
        )
        .limit(1);
      if (!fb[0]) {
        throw new LearningOwnershipError(
          `sourceFeedbackId ${input.sourceFeedbackId} does not belong to this (tenant, actor)`,
        );
      }

      // Nearest existing PERSONAL rule for this actor (tenant + actor + scope).
      const near = await tx
        .select({
          id: learnedRules.id,
          confidence: learnedRules.confidence,
          reinforcementCount: learnedRules.reinforcementCount,
          distance,
        })
        .from(learnedRules)
        .where(
          and(
            eq(learnedRules.tenantId, ctx.tenantId),
            eq(learnedRules.actor, ctx.actor),
            eq(learnedRules.scope, 'personal'),
          ),
        )
        .orderBy(distance)
        .limit(1);

      const top = near[0];
      if (top && 1 - Number(top.distance) >= RULE_DEDUP_SIMILARITY) {
        // Reinforce: bump count + recency; raise confidence toward the stronger of
        // the two (deterministic, never decreasing). No second row.
        const nextConfidence = Math.min(1, Math.max(top.confidence, input.confidence));
        const updated = await tx
          .update(learnedRules)
          .set({
            confidence: nextConfidence,
            reinforcementCount: top.reinforcementCount + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(learnedRules.tenantId, ctx.tenantId), eq(learnedRules.id, top.id)))
          .returning();
        const row = updated[0];
        if (!row) throw new LearningStoreError('reinforce returned no row');
        return { rule: ruleFromRow(row), reinforced: true };
      }

      const inserted = await tx
        .insert(learnedRules)
        .values({
          tenantId: ctx.tenantId,
          actor: ctx.actor,
          scope: input.scope,
          ruleText: input.ruleText,
          ruleKey: input.ruleKey,
          embedding: [...input.embedding],
          sourceFeedbackId: input.sourceFeedbackId,
          confidence: input.confidence,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new LearningStoreError('insertRule returned no row');
      return { rule: ruleFromRow(row), reinforced: false };
    });
  }

  /**
   * Load this actor's personal rules (newest first). Read-time decay + conflict
   * resolution + budget are the CALLER's job (web layer) — the store never mutates
   * stored rows for ranking.
   */
  async listRules(ctx: LearningContext): Promise<LearnedRule[]> {
    const rows = await this.db
      .select()
      .from(learnedRules)
      .where(
        and(
          eq(learnedRules.tenantId, ctx.tenantId),
          eq(learnedRules.actor, ctx.actor),
          eq(learnedRules.scope, 'personal'),
        ),
      )
      .orderBy(desc(learnedRules.updatedAt));
    return rows.map(ruleFromRow);
  }

  // -------------------------------------------------------------------------
  // Shared (tenant-wide) rules (P5b) — the GATED promotion write + load.
  // -------------------------------------------------------------------------

  /**
   * Create (or reinforce) a SHARED, tenant-wide rule — the SINGLE place a shared
   * rule is written. This is the engine half of the steward-approved promotion:
   * the caller (the web approve action) is responsible for the human gate
   * (REVIEW_CORRECTIONS) and for running this inside the same transaction as the
   * audit row + queue resolution. The store enforces only the data invariants:
   *
   *   • scope is forced to 'shared' — there is no scope parameter to misuse.
   *   • PROVENANCE-GATED — sourceFeedbackId (inherited from the promoted personal
   *     rule) is required, exactly like insertRule.
   *   • DEDUP-REINFORCE — probes the TENANT's existing shared rules (NOT
   *     actor-scoped, unlike personal): a near-duplicate (cosine ≥ 0.92) is
   *     reinforced rather than duplicated, so two stewards promoting the same idea
   *     collapse to one shared row.
   *
   * `actor` records the APPROVING steward (provenance of who made it company-wide);
   * a reinforce keeps the existing row's actor (the original approver). Mirrors
   * insertRule's atomicity + concurrency notes (probe + write in one transaction,
   * not serialised against a concurrent caller — the read side self-heals).
   */
  async writeSharedRule(
    ctx: LearningContext,
    input: WriteSharedRuleInput,
  ): Promise<InsertRuleResult> {
    if (!input.sourceFeedbackId || input.sourceFeedbackId.trim() === '') {
      throw new LearningProvenanceError();
    }
    assertRuleTextBounds(input.ruleText);
    if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new LearningStoreError(
        `embedding must be ${EMBEDDING_DIMENSIONS}-dim, got ${input.embedding.length}`,
      );
    }
    const literal = `[${input.embedding.join(',')}]`;
    const distance: SQL<number> = sql<number>`${learnedRules.embedding} <=> ${literal}::vector`;

    return this.db.transaction(async (tx) => {
      // Ownership gate (F56): the inherited provenance pointer must reference
      // THIS tenant's feedback. Tenant-scoped only — the original signal came
      // from the proposer, not the approving steward, so no actor check here.
      const fb = await tx
        .select({ id: generationFeedback.id })
        .from(generationFeedback)
        .where(
          and(
            eq(generationFeedback.tenantId, ctx.tenantId),
            eq(generationFeedback.id, input.sourceFeedbackId),
          ),
        )
        .limit(1);
      if (!fb[0]) {
        throw new LearningOwnershipError(
          `sourceFeedbackId ${input.sourceFeedbackId} does not belong to this tenant`,
        );
      }

      // Nearest existing SHARED rule for this TENANT (tenant + scope='shared') —
      // tenant-wide, NOT actor-scoped, so dedup spans every steward's promotions.
      const near = await tx
        .select({
          id: learnedRules.id,
          confidence: learnedRules.confidence,
          reinforcementCount: learnedRules.reinforcementCount,
          distance,
        })
        .from(learnedRules)
        .where(and(eq(learnedRules.tenantId, ctx.tenantId), eq(learnedRules.scope, 'shared')))
        .orderBy(distance)
        .limit(1);

      const top = near[0];
      if (top && 1 - Number(top.distance) >= RULE_DEDUP_SIMILARITY) {
        const nextConfidence = Math.min(1, Math.max(top.confidence, input.confidence));
        const updated = await tx
          .update(learnedRules)
          .set({
            confidence: nextConfidence,
            reinforcementCount: top.reinforcementCount + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(learnedRules.tenantId, ctx.tenantId), eq(learnedRules.id, top.id)))
          .returning();
        const row = updated[0];
        if (!row) throw new LearningStoreError('shared reinforce returned no row');
        return { rule: ruleFromRow(row), reinforced: true };
      }

      const inserted = await tx
        .insert(learnedRules)
        .values({
          tenantId: ctx.tenantId,
          actor: ctx.actor, // the APPROVING steward — provenance of the promotion
          scope: 'shared',
          ruleText: input.ruleText,
          ruleKey: input.ruleKey,
          embedding: [...input.embedding],
          sourceFeedbackId: input.sourceFeedbackId,
          confidence: input.confidence,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new LearningStoreError('writeSharedRule returned no row');
      return { rule: ruleFromRow(row), reinforced: false };
    });
  }

  /**
   * Load the tenant's SHARED rules (newest first) for injection. Tenant-wide:
   * filtered on (tenant_id, scope='shared') and INTENTIONALLY NOT on actor, so
   * every user in the tenant gets the same company defaults. Read-time decay +
   * conflict resolution + budget are the CALLER's job (web layer), applied across
   * the combined personal+shared set with personal-overrides-shared precedence —
   * the store never mutates stored rows for ranking.
   */
  async loadSharedRulesForInjection(ctx: LearningContext): Promise<LearnedRule[]> {
    const rows = await this.db
      .select()
      .from(learnedRules)
      .where(and(eq(learnedRules.tenantId, ctx.tenantId), eq(learnedRules.scope, 'shared')))
      .orderBy(desc(learnedRules.updatedAt));
    return rows.map(ruleFromRow);
  }

  // -------------------------------------------------------------------------
  // style_profiles
  // -------------------------------------------------------------------------

  /** Overwrite this actor's single always-injected style profile in place. */
  async upsertStyleProfile(ctx: LearningContext, profileText: string): Promise<StyleProfile> {
    const rows = await this.db
      .insert(styleProfiles)
      .values({ tenantId: ctx.tenantId, actor: ctx.actor, scope: 'personal', profileText })
      .onConflictDoUpdate({
        target: [styleProfiles.tenantId, styleProfiles.actor, styleProfiles.scope],
        set: { profileText, updatedAt: new Date() },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new LearningStoreError('upsertStyleProfile returned no row');
    return profileFromRow(row);
  }

  /** This actor's style profile, or null when none stored. */
  async getStyleProfile(ctx: LearningContext): Promise<StyleProfile | null> {
    const rows = await this.db
      .select()
      .from(styleProfiles)
      .where(
        and(
          eq(styleProfiles.tenantId, ctx.tenantId),
          eq(styleProfiles.actor, ctx.actor),
          eq(styleProfiles.scope, 'personal'),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? profileFromRow(row) : null;
  }
}

// ---------------------------------------------------------------------------
// Invariant guard + row mappers
// ---------------------------------------------------------------------------

function assertPersonal(scope: LearningScope): void {
  // Defence in depth on the NON-gated paths: the type allows 'shared', but a JS
  // caller (the web tier) could pass it. Reject at runtime so the only way to
  // write a shared row is the gated writeSharedRule (steward-approved promotion).
  if ((scope as string) !== 'personal') throw new LearningScopeError(scope as string);
}

// Deterministic size bounds (G2a/P2-1) on every rule write. Runs BEFORE any
// database access, so a violating rule never reaches a transaction. Counts are
// over the raw string (what would be stored + injected), not a trimmed view.
function assertRuleTextBounds(ruleText: string): void {
  if (ruleText.trim() === '') {
    throw new LearningRuleBoundsError('rule text must not be empty');
  }
  if (ruleText.length > RULE_TEXT_MAX_CHARS) {
    throw new LearningRuleBoundsError(
      `rule text is ${ruleText.length} chars; the cap is ${RULE_TEXT_MAX_CHARS}`,
    );
  }
  const lines = ruleText.split(/\r\n|\r|\n/).length;
  if (lines > RULE_TEXT_MAX_LINES) {
    throw new LearningRuleBoundsError(
      `rule text spans ${lines} lines; the cap is ${RULE_TEXT_MAX_LINES}`,
    );
  }
}

function feedbackFromRow(row: typeof generationFeedback.$inferSelect): GenerationFeedback {
  return {
    id: row.id,
    tenantId: asTenantId(row.tenantId),
    actor: asActorId(row.actor),
    context: (row.context ?? {}) as FeedbackContext,
    modelDraft: row.modelDraft,
    humanFinal: row.humanFinal,
    decision: row.decision as FeedbackDecision,
    scope: row.scope as LearningScope,
    inferredRuleId: row.inferredRuleId,
    confidence: row.confidence,
    contentScrubbedAt: row.contentScrubbedAt,
    createdAt: row.createdAt,
  };
}

function ruleFromRow(row: typeof learnedRules.$inferSelect): LearnedRule {
  return {
    id: row.id,
    tenantId: asTenantId(row.tenantId),
    actor: asActorId(row.actor),
    scope: row.scope as LearningScope,
    ruleText: row.ruleText,
    ruleKey: row.ruleKey,
    sourceFeedbackId: row.sourceFeedbackId,
    confidence: row.confidence,
    reinforcementCount: row.reinforcementCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function profileFromRow(row: typeof styleProfiles.$inferSelect): StyleProfile {
  return {
    id: row.id,
    tenantId: asTenantId(row.tenantId),
    actor: asActorId(row.actor),
    scope: row.scope as LearningScope,
    profileText: row.profileText,
    updatedAt: row.updatedAt,
  };
}
