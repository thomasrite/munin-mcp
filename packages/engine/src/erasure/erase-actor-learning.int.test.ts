// Integration tests for eraseActorLearning (G2a/F55 DSAR leg) on REAL Postgres.
//
// Proves the delete/scrub decision table:
//   - personal rules + style profile: DELETED
//   - feedback referenced ONLY by deleted personal rules (or by nothing): DELETED
//   - feedback referenced by a SHARED rule: SCRUBBED in place (content NULL,
//     marker stamped, inferred_rule_id NULLed) — the shared rule and its
//     provenance pointer survive (company property post-steward-approval)
//   - PENDING review-queue promotions of the deleted rules: DELETED (a stale
//     pending item could otherwise be approved after erasure)
//   - resolved items, other actors, other tenants: UNTOUCHED
//   - one content-free in-tx audit row; the receipt counts match
//   - atomic: a failed audit write rolls EVERYTHING back (no partial state)

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { learnedRules, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type ActorId,
  type ReviewItem,
  type TenantId,
  asActorId,
  asTenantId,
} from '../graph/types';
import { LearningStore } from '../learning/learning-store';
import type { LearningContext } from '../learning/types';

import { eraseActorLearning } from './erase-actor-learning';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let learning: LearningStore;
let graph: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000aa');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000bb');
const ALICE = asActorId('alice'); // the actor being erased
const BOB = asActorId('bob'); // a bystander whose data must survive
const ADMIN = asActorId('admin-dpo'); // the requesting admin (audit actor)

const ctxOf = (tenantId: TenantId, actor: ActorId): LearningContext => ({ tenantId, actor });
const writeCtx = { tenantId: TENANT_A, actor: ADMIN };

function vec(overrides: Record<number, number>): number[] {
  const v = Array.from({ length: 1024 }, () => 0);
  for (const [i, value] of Object.entries(overrides)) v[Number(i)] = value;
  return v;
}

async function seedFeedback(ctx: LearningContext): Promise<string> {
  const fb = await learning.recordFeedback(ctx, {
    context: { templateId: 't1' },
    modelDraft: 'Munin drafted this.',
    humanFinal: 'The human shortened this.',
    decision: 'edit',
    scope: 'personal',
  });
  return fb.id;
}

async function seedRule(
  ctx: LearningContext,
  feedbackId: string,
  axis: number,
  ruleKey: string,
): Promise<string> {
  const { rule } = await learning.insertRule(ctx, {
    sourceFeedbackId: feedbackId,
    scope: 'personal',
    ruleText: `Prefer style ${ruleKey}.`,
    ruleKey,
    embedding: vec({ [axis]: 1 }),
    confidence: 0.8,
  });
  return rule.id;
}

async function seedPendingPromotion(
  ctx: { tenantId: TenantId; actor: ActorId },
  ruleId: string,
): Promise<ReviewItem> {
  return graph.enqueueReviewItem(ctx, {
    targetKind: 'learned_rule',
    targetId: ruleId,
    proposedChange: { kind: 'learned-rule-promotion', ruleText: 'Prefer style x.' },
    accessTags: ['team:a'],
    note: null,
  });
}

async function reviewQueueIds(): Promise<string[]> {
  const res = await db.execute(sql`SELECT id FROM review_queue ORDER BY created_at`);
  return [...res].map((r) => String((r as Record<string, unknown>).id));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri());
  db = drizzle(client);
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Tenant A' },
    { id: TENANT_B, name: 'Tenant B' },
  ]);
  learning = new LearningStore(db);
  graph = new PostgresGraphStore(db);
}, 120_000);

afterEach(async () => {
  await db.execute(sql`DELETE FROM review_queue`);
  await db.delete(learnedRules);
  await db.execute(sql`DELETE FROM generation_feedback`);
  await db.execute(sql`DELETE FROM style_profiles`);
  await db.execute(sql`DELETE FROM audit_events`);
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

describe('eraseActorLearning — the delete/scrub decision table', () => {
  it('deletes rules+profile+feedback, scrubs shared-referenced feedback, sweeps pending promotions', async () => {
    const alice = ctxOf(TENANT_A, ALICE);

    // fb1 → personal rule r1 (referenced by personal only → fb1 DELETED).
    const fb1 = await seedFeedback(alice);
    const r1 = await seedRule(alice, fb1, 0, 'tone');
    await learning.linkFeedbackRule(alice, fb1, { ruleId: r1, confidence: 0.8 });
    // fb2 → personal rule r2, PROMOTED to a shared rule (steward path) →
    // fb2 SCRUBBED, r2 deleted, the shared rule survives.
    const fb2 = await seedFeedback(alice);
    const r2 = await seedRule(alice, fb2, 5, 'structure');
    await learning.writeSharedRule(ctxOf(TENANT_A, asActorId('steward')), {
      sourceFeedbackId: fb2,
      ruleText: 'Open with the decision.',
      ruleKey: 'structure',
      embedding: vec({ 9: 1 }),
      confidence: 0.7,
    });
    // fb3: plain feedback, no rule → DELETED.
    await seedFeedback(alice);
    await learning.upsertStyleProfile(alice, 'Writes plainly.');

    // Pending promotion of r1 → swept. Resolved (rejected) item targeting r2 →
    // stays (the decision trail; the F54 resolved-item retention scrub, not
    // erasure, handles its payload).
    const pendingPromo = await seedPendingPromotion(alice, r1);
    const resolved = await seedPendingPromotion(alice, r2);
    await graph.resolveReviewItem(
      { tenantId: TENANT_A, actor: asActorId('steward') },
      resolved.id,
      {
        decision: 'rejected',
      },
    );
    // A pending promotion of BOB's rule + Bob's data → untouched.
    const bob = ctxOf(TENANT_A, BOB);
    const bobFb = await seedFeedback(bob);
    const bobRule = await seedRule(bob, bobFb, 7, 'length');
    const bobPromo = await seedPendingPromotion({ tenantId: TENANT_A, actor: BOB }, bobRule);
    await learning.upsertStyleProfile(bob, 'Loves bullet points.');
    // Tenant B's ALICE — same actor id, different tenant → untouched.
    const aliceB = ctxOf(TENANT_B, ALICE);
    const fbB = await seedFeedback(aliceB);

    const receipt = await eraseActorLearning(db, writeCtx, ALICE);

    expect(receipt.counts).toEqual({
      personalRulesDeleted: 2, // r1 + r2
      styleProfilesDeleted: 1,
      feedbackDeleted: 2, // fb1 + fb3
      feedbackScrubbed: 1, // fb2 (shared-referenced)
      pendingRulePromotionsDeleted: 1, // r1's pending promotion
    });
    expect(receipt.erasedActor).toBe(ALICE);
    expect(receipt.requestedBy).toBe(ADMIN);

    // Alice's learning data is gone…
    expect(await learning.listRules(alice)).toHaveLength(0);
    expect(await learning.getStyleProfile(alice)).toBeNull();
    const remaining = await learning.listFeedback(alice);
    expect(remaining).toHaveLength(1);
    // …except the shared-referenced row, scrubbed: content NULL, marker set,
    // the dangling personal-rule pointer NULLed, metadata intact.
    const scrubbed = remaining[0];
    expect(scrubbed?.id).toBe(fb2);
    expect(scrubbed?.modelDraft).toBeNull();
    expect(scrubbed?.humanFinal).toBeNull();
    expect(scrubbed?.contentScrubbedAt).toBeInstanceOf(Date);
    expect(scrubbed?.inferredRuleId).toBeNull();
    expect(scrubbed?.decision).toBe('edit');
    // The shared rule survives with its provenance pointer resolving to fb2.
    const shared = await learning.loadSharedRulesForInjection(alice);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.sourceFeedbackId).toBe(fb2);
    // Queue: r1's pending promotion gone; the resolved item + Bob's survive.
    const queueIds = await reviewQueueIds();
    expect(queueIds).not.toContain(pendingPromo.id);
    expect(queueIds).toContain(resolved.id);
    expect(queueIds).toContain(bobPromo.id);
    // Bystanders intact.
    expect(await learning.listRules(bob)).toHaveLength(1);
    expect((await learning.getStyleProfile(bob))?.profileText).toBe('Loves bullet points.');
    expect((await learning.listFeedback(bob))[0]?.modelDraft).toBe('Munin drafted this.');
    expect((await learning.listFeedback(aliceB))[0]?.id).toBe(fbB);
    expect((await learning.listFeedback(aliceB))[0]?.modelDraft).toBe('Munin drafted this.');
  });

  it('writes one content-free in-tx audit row (exact key set)', async () => {
    const alice = ctxOf(TENANT_A, ALICE);
    await seedFeedback(alice);

    await eraseActorLearning(db, writeCtx, ALICE);

    const res = await db.execute(
      sql`SELECT actor, action, target_kind, target_id, access_tags_used, details
          FROM audit_events WHERE action = 'erase_actor_learning'`,
    );
    const rows = [...res] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(ADMIN);
    expect(rows[0]?.target_kind).toBe('tenant');
    expect(rows[0]?.target_id).toBe(TENANT_A);
    expect(rows[0]?.access_tags_used).toEqual([]);
    // Counts + the erased actor's identifier only — assert the exact key set so
    // content can never ride along.
    const details = rows[0]?.details as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual([
      'erasedActor',
      'feedbackDeleted',
      'feedbackScrubbed',
      'pendingRulePromotionsDeleted',
      'personalRulesDeleted',
      'styleProfilesDeleted',
    ]);
    expect(details.erasedActor).toBe(ALICE);
    expect(details.feedbackDeleted).toBe(1);
  });

  it('is atomic: a failed audit write rolls EVERYTHING back — no partial state', async () => {
    const alice = ctxOf(TENANT_A, ALICE);
    const fb1 = await seedFeedback(alice);
    const r1 = await seedRule(alice, fb1, 0, 'tone');
    await learning.upsertStyleProfile(alice, 'Writes plainly.');
    const promo = await seedPendingPromotion(alice, r1);

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_erasure_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'erase_actor_learning' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER erasure_audit_fails BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION fail_erasure_audit();
    `);
    try {
      await expect(eraseActorLearning(db, writeCtx, ALICE)).rejects.toThrow(
        /audit_events|audit unavailable/,
      );
    } finally {
      await db.execute(sql`
        DROP TRIGGER erasure_audit_fails ON audit_events;
        DROP FUNCTION fail_erasure_audit();
      `);
    }

    // Nothing was erased: rules, profile, feedback, and the pending item are intact.
    expect(await learning.listRules(alice)).toHaveLength(1);
    expect((await learning.getStyleProfile(alice))?.profileText).toBe('Writes plainly.');
    const fb = await learning.listFeedback(alice);
    expect(fb).toHaveLength(1);
    expect(fb[0]?.modelDraft).toBe('Munin drafted this.');
    expect(await reviewQueueIds()).toContain(promo.id);
  });

  it('erasing a STEWARD leaves the shared rules they approved untouched (scope filter)', async () => {
    // The shared rule's `actor` column records the approving steward. Erasing
    // that steward must delete only their PERSONAL rows — the scope='personal'
    // filter is all that stands between a DSAR and deleting company property.
    const steward = asActorId('steward');
    const stewardCtx = ctxOf(TENANT_A, steward);
    // Bob's feedback is the shared rule's provenance (proposer ≠ steward).
    const bobFb = await seedFeedback(ctxOf(TENANT_A, BOB));
    await learning.writeSharedRule(stewardCtx, {
      sourceFeedbackId: bobFb,
      ruleText: 'Open with the decision.',
      ruleKey: 'structure',
      embedding: vec({ 9: 1 }),
      confidence: 0.7,
    });
    // The steward also has personal learning data of their own.
    const ownFb = await seedFeedback(stewardCtx);
    await seedRule(stewardCtx, ownFb, 3, 'tone');
    await learning.upsertStyleProfile(stewardCtx, 'Brisk.');

    const receipt = await eraseActorLearning(db, writeCtx, steward);

    expect(receipt.counts.personalRulesDeleted).toBe(1);
    expect(receipt.counts.feedbackDeleted).toBe(1);
    // The shared rule survives (still actor-stamped with the erased steward —
    // accountability provenance, an identifier, not content)…
    const shared = await learning.loadSharedRulesForInjection(stewardCtx);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.actor).toBe(steward);
    // …and Bob's source feedback was never the steward's to scrub or delete.
    const bobRows = await learning.listFeedback(ctxOf(TENANT_A, BOB));
    expect(bobRows[0]?.id).toBe(bobFb);
    expect(bobRows[0]?.modelDraft).toBe('Munin drafted this.');
  });

  it('preserves an earlier scrub stamp (COALESCE) and dedups multi-shared-rule references', async () => {
    const alice = ctxOf(TENANT_A, ALICE);
    const fb = await seedFeedback(alice);
    // TWO shared rules referencing the same feedback row (orthogonal embeddings
    // so dedup-reinforce keeps them distinct) — the selectDistinct must collapse
    // the reference set to one scrub.
    const steward = ctxOf(TENANT_A, asActorId('steward'));
    await learning.writeSharedRule(steward, {
      sourceFeedbackId: fb,
      ruleText: 'Open with the decision.',
      ruleKey: 'structure',
      embedding: vec({ 9: 1 }),
      confidence: 0.7,
    });
    await learning.writeSharedRule(steward, {
      sourceFeedbackId: fb,
      ruleText: 'Use plain words.',
      ruleKey: 'vocabulary',
      embedding: vec({ 30: 1 }),
      confidence: 0.7,
    });
    // The row was already scrubbed by an earlier retention sweep at a known time.
    const earlier = '2026-01-01T00:00:00.000Z';
    await db.execute(
      sql`UPDATE generation_feedback
          SET model_draft = NULL, human_final = NULL, content_scrubbed_at = ${earlier}::timestamptz
          WHERE id = ${fb}`,
    );

    const receipt = await eraseActorLearning(db, writeCtx, ALICE);

    expect(receipt.counts.feedbackScrubbed).toBe(1); // one row, not two
    expect(receipt.counts.feedbackDeleted).toBe(0);
    const row = (await learning.listFeedback(alice)).find((f) => f.id === fb);
    // The ORIGINAL stamp survives — the marker records when content FIRST left.
    expect(row?.contentScrubbedAt?.toISOString()).toBe(earlier);
  });

  it('erasing an actor with no learning data succeeds with a zero receipt (idempotent)', async () => {
    const receipt = await eraseActorLearning(db, writeCtx, asActorId('nobody'));
    expect(receipt.counts).toEqual({
      personalRulesDeleted: 0,
      styleProfilesDeleted: 0,
      feedbackDeleted: 0,
      feedbackScrubbed: 0,
      pendingRulePromotionsDeleted: 0,
    });
  });
});
