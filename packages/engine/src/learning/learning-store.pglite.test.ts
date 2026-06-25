// STOP GATE (P5a): prove the LearningStore — including the pgvector `<=>` dedup
// probe — runs UNCHANGED on PGlite (real Postgres compiled to WASM), the
// local/desktop backend. Runs IN-PROCESS (no Docker), so it lives in the unit
// suite alongside pglite-graph-store.test.ts.
//
// The full store SEMANTICS (provenance gate, scope lock, isolation) are proven
// against real Postgres in learning-store.int.test.ts; here we prove the SAME
// code path — notably the cosine dedup-reinforce — applies and runs on PGlite.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tenants } from '../db/schema';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import { type TenantId, asActorId, asTenantId } from '../graph/types';

import { LearningStore } from './learning-store';
import type { LearningContext } from './types';

const TENANT = asTenantId(crypto.randomUUID());
const ACTOR = asActorId('local-user');
const ctx: LearningContext = { tenantId: TENANT as TenantId, actor: ACTOR };

function vec(overrides: Record<number, number>): number[] {
  const v = Array.from({ length: 1024 }, () => 0);
  for (const [i, value] of Object.entries(overrides)) v[Number(i)] = value;
  return v;
}

let handle: PgliteGraphStoreHandle;
let store: LearningStore;

beforeAll(async () => {
  handle = await createPgliteGraphStore({}); // in-memory PGlite + pgvector
  await handle.db.insert(tenants).values({ id: TENANT, name: 'Local Tenant' });
  store = new LearningStore(handle.db);
});

afterAll(async () => {
  await handle?.close();
});

describe('LearningStore on PGlite', () => {
  it('records feedback and dedup-reinforces a near-duplicate rule via the cosine probe', async () => {
    const fb = await store.recordFeedback(ctx, {
      context: { templateId: 't' },
      modelDraft: 'draft',
      humanFinal: 'final',
      decision: 'edit',
      scope: 'personal',
    });
    // 0015 applies on PGlite: the scrub marker exists and a fresh row's content
    // is intact (content_scrubbed_at NULL).
    expect(fb.contentScrubbedAt).toBeNull();

    const first = await store.insertRule(ctx, {
      sourceFeedbackId: fb.id,
      scope: 'personal',
      ruleText: 'Prefer concise sentences.',
      ruleKey: 'tone:concise',
      embedding: vec({ 0: 1 }),
      confidence: 0.7,
    });
    expect(first.reinforced).toBe(false);

    // Near-duplicate (cosine ≈ 0.995) → the `<=>` probe reinforces on PGlite too.
    const second = await store.insertRule(ctx, {
      sourceFeedbackId: fb.id,
      scope: 'personal',
      ruleText: 'Keep it short.',
      ruleKey: 'tone:concise',
      embedding: vec({ 0: 1, 1: 0.1 }),
      confidence: 0.9,
    });
    expect(second.reinforced).toBe(true);
    expect(second.rule.reinforcementCount).toBe(2);
    expect(await store.listRules(ctx)).toHaveLength(1);

    // A style profile round-trips on PGlite.
    await store.upsertStyleProfile(ctx, 'Writes plainly.');
    expect((await store.getStyleProfile(ctx))?.profileText).toBe('Writes plainly.');
  });

  it('writes + dedup-reinforces a SHARED rule via the same cosine probe (P5b)', async () => {
    const fb = await store.recordFeedback(ctx, {
      context: { templateId: 't' },
      modelDraft: 'draft',
      humanFinal: 'final',
      decision: 'edit',
      scope: 'personal',
    });

    const first = await store.writeSharedRule(ctx, {
      sourceFeedbackId: fb.id,
      ruleText: 'Open with the decision.',
      ruleKey: 'structure:decision-first',
      embedding: vec({ 5: 1 }),
      confidence: 0.7,
    });
    expect(first.reinforced).toBe(false);
    expect(first.rule.scope).toBe('shared');

    // Near-duplicate (cosine ≈ 0.995) → reinforces tenant-wide on PGlite too.
    const second = await store.writeSharedRule(ctx, {
      sourceFeedbackId: fb.id,
      ruleText: 'Lead with the decision.',
      ruleKey: 'structure:decision-first',
      embedding: vec({ 5: 1, 6: 0.1 }),
      confidence: 0.9,
    });
    expect(second.reinforced).toBe(true);
    expect(await store.loadSharedRulesForInjection(ctx)).toHaveLength(1);
  });

  it('runs the retention sweep on PGlite — scrub-in-place + the in-tx audit row (G2a/F55)', async () => {
    // Local mode has no cron — the CLI runs this same orchestration, so prove
    // the whole path (LearningStore scrub + GraphStore audit, one tx) on PGlite.
    const { retentionCutoff, runRetentionSweep } = await import('../retention/retention-sweep');

    const expired = await store.recordFeedback(ctx, {
      context: { templateId: 't2' },
      modelDraft: 'old draft',
      humanFinal: 'old final',
      decision: 'edit',
      scope: 'personal',
    });
    await handle.db.execute(
      sql`UPDATE generation_feedback SET created_at = now() - interval '100 days' WHERE id = ${expired.id}`,
    );

    const result = await runRetentionSweep(
      handle.db,
      { tenantId: ctx.tenantId, actor: ctx.actor },
      { feedbackCutoff: retentionCutoff(90), reviewCutoff: retentionCutoff(90) },
    );
    expect(result.feedbackScrubbed).toBe(1);
    expect(result.reviewItemsScrubbed).toBe(0);

    const scrubbed = (await store.listFeedback(ctx)).find((f) => f.id === expired.id);
    expect(scrubbed?.modelDraft).toBeNull();
    expect(scrubbed?.humanFinal).toBeNull();
    expect(scrubbed?.contentScrubbedAt).toBeInstanceOf(Date);

    const audit = await handle.db.execute(
      sql`SELECT details FROM audit_events WHERE action = 'retention_sweep'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('runs the per-actor learning erasure on PGlite — delete/scrub split + promotion sweep (G2a/F55)', async () => {
    const { eraseActorLearning } = await import('../erasure/erase-actor-learning');

    // A separate actor so this test owns its rows outright.
    const target = { tenantId: ctx.tenantId, actor: asActorId('erase-me') };
    const fb = await store.recordFeedback(target, {
      context: { templateId: 't3' },
      modelDraft: 'their draft',
      humanFinal: 'their final',
      decision: 'edit',
      scope: 'personal',
    });
    const { rule } = await store.insertRule(target, {
      sourceFeedbackId: fb.id,
      scope: 'personal',
      ruleText: 'Avoid jargon.',
      ruleKey: 'vocabulary',
      embedding: vec({ 20: 1 }),
      confidence: 0.6,
    });
    await store.upsertStyleProfile(target, 'Plain words.');
    const promo = await handle.store.enqueueReviewItem(target, {
      targetKind: 'learned_rule',
      targetId: rule.id,
      proposedChange: { kind: 'learned-rule-promotion', ruleText: 'Avoid jargon.' },
      accessTags: ['team:local'],
      note: null,
    });

    const receipt = await eraseActorLearning(
      handle.db,
      { tenantId: ctx.tenantId, actor: asActorId('local-admin') },
      target.actor,
    );
    expect(receipt.counts).toEqual({
      personalRulesDeleted: 1,
      styleProfilesDeleted: 1,
      feedbackDeleted: 1,
      feedbackScrubbed: 0,
      pendingRulePromotionsDeleted: 1,
    });
    expect(await store.listRules(target)).toHaveLength(0);
    expect(await store.getStyleProfile(target)).toBeNull();
    expect(await store.listFeedback(target)).toHaveLength(0);
    const queue = await handle.db.execute(sql`SELECT id FROM review_queue WHERE id = ${promo.id}`);
    expect(queue.rows).toHaveLength(0);
  });
});
