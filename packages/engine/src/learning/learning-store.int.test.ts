// Integration tests for the LearningStore (P5a) against REAL Postgres.
//
// Proves the per-(tenant, actor) learning-metadata store's invariants:
//   - PROVENANCE-GATED: a learned_rules insert with no sourceFeedbackId is rejected
//   - SCOPE-LOCKED: a non-'personal' write is rejected — no shared rule can exist
//   - DEDUP-REINFORCE: a ≥0.92 near-duplicate reinforces (no second row); a
//     dissimilar embedding inserts a new rule
//   - PERSONAL ISOLATION: one actor's rules never reach another; one tenant's
//     never reach another (the no-leak guarantee for this metadata store)
//   - OWNERSHIP-CHECKED (F56): caller-supplied cross-references are verified —
//     insertRule/writeSharedRule reject a foreign sourceFeedbackId;
//     linkFeedbackRule rejects a rule id the caller does not own
//   - feedback round-trip + link + style-profile upsert-in-place
//
// The vector dedup uses pgvector's `<=>` — so this also exercises the cosine
// operator over the HNSW-indexed learned_rules.embedding column on real Postgres.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { learnedRules, tenants } from '../db/schema';
import { type TenantId, asActorId, asTenantId } from '../graph/types';

import {
  LearningOwnershipError,
  LearningProvenanceError,
  LearningRuleBoundsError,
  LearningScopeError,
} from './errors';
import { LearningStore, RULE_TEXT_MAX_CHARS } from './learning-store';
import type { LearningContext, LearningScope } from './types';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: LearningStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000aa');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000bb');
const ALICE = asActorId('alice');
const BOB = asActorId('bob');

const ctxOf = (tenantId: TenantId, actor = ALICE): LearningContext => ({ tenantId, actor });

// A 1024-dim vector with chosen non-zero coordinates (rest zero). Cosine is
// normalisation-invariant, so these define clear similar/dissimilar pairs.
function vec(overrides: Record<number, number>): number[] {
  const v = Array.from({ length: 1024 }, () => 0);
  for (const [i, value] of Object.entries(overrides)) v[Number(i)] = value;
  return v;
}
const V1 = vec({ 0: 1 }); // axis 0
const V1_NEAR = vec({ 0: 1, 1: 0.1 }); // cosine to V1 ≈ 0.995 → reinforce
const V2 = vec({ 5: 1 }); // orthogonal to V1 → cosine 0 → insert

async function seedFeedback(ctx: LearningContext): Promise<string> {
  const fb = await store.recordFeedback(ctx, {
    context: { templateId: 't1' },
    modelDraft: 'Munin drafted this.',
    humanFinal: 'The human shortened this.',
    decision: 'edit',
    scope: 'personal',
  });
  return fb.id;
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
  store = new LearningStore(db);
}, 120_000);

afterEach(async () => {
  // Order matters: learned_rules FKs generation_feedback.
  await db.delete(learnedRules);
  await db.execute(sql`DELETE FROM generation_feedback`);
  await db.execute(sql`DELETE FROM style_profiles`);
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

describe('LearningStore — feedback', () => {
  it('records and round-trips a feedback signal, actor-scoped', async () => {
    const fb = await store.recordFeedback(ctxOf(TENANT_A), {
      context: { templateId: 'hr-summary', documentId: 'doc-1' },
      modelDraft: 'draft text',
      humanFinal: 'final text',
      decision: 'edit',
      scope: 'personal',
    });
    expect(fb.id).toBeTruthy();
    expect(fb.decision).toBe('edit');
    expect(fb.inferredRuleId).toBeNull();

    const mine = await store.listFeedback(ctxOf(TENANT_A));
    expect(mine).toHaveLength(1);
    // Bob (same tenant) sees none of Alice's feedback.
    expect(await store.listFeedback(ctxOf(TENANT_A, BOB))).toHaveLength(0);
  });

  it('links a feedback row to its inferred rule', async () => {
    const fbId = await seedFeedback(ctxOf(TENANT_A));
    const { rule } = await store.insertRule(ctxOf(TENANT_A), {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: 'Prefer concise sentences.',
      ruleKey: 'tone:concise',
      embedding: V1,
      confidence: 0.8,
    });
    await store.linkFeedbackRule(ctxOf(TENANT_A), fbId, { ruleId: rule.id, confidence: 0.8 });
    const [fb] = await store.listFeedback(ctxOf(TENANT_A));
    expect(fb?.inferredRuleId).toBe(rule.id);
    expect(fb?.confidence).toBeCloseTo(0.8);
  });
});

describe('LearningStore — rule invariants', () => {
  it('rejects a rule with no source feedback (provenance gate)', async () => {
    await expect(
      store.insertRule(ctxOf(TENANT_A), {
        sourceFeedbackId: '',
        scope: 'personal',
        ruleText: 'x',
        ruleKey: 'k',
        embedding: V1,
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningProvenanceError);
  });

  it('rejects a non-personal scope (no shared rule can be created)', async () => {
    const fbId = await seedFeedback(ctxOf(TENANT_A));
    await expect(
      store.insertRule(ctxOf(TENANT_A), {
        sourceFeedbackId: fbId,
        // reason: deliberately bypass the 'personal'-only type to prove the
        // runtime guard rejects a shared write the way a JS caller could attempt.
        scope: 'shared' as unknown as LearningScope,
        ruleText: 'x',
        ruleKey: 'k',
        embedding: V1,
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningScopeError);
    expect(await store.listRules(ctxOf(TENANT_A))).toHaveLength(0);
  });

  it('rejects a wrong-dimension embedding', async () => {
    const fbId = await seedFeedback(ctxOf(TENANT_A));
    await expect(
      store.insertRule(ctxOf(TENANT_A), {
        sourceFeedbackId: fbId,
        scope: 'personal',
        ruleText: 'x',
        ruleKey: 'k',
        embedding: [1, 2, 3],
        confidence: 0.5,
      }),
    ).rejects.toThrow(/1024-dim/);
  });

  it('bounds (G2a/P2-1): a rule AT the caps is accepted; over either cap is rejected on both paths', async () => {
    const ctx = ctxOf(TENANT_A);
    const fbId = await seedFeedback(ctx);
    // Exactly at both caps → accepted (existing valid rules unaffected).
    const atCaps = `${'x'.repeat(RULE_TEXT_MAX_CHARS - 2)}\na`; // 500 chars, 2 lines
    expect(atCaps.length).toBe(RULE_TEXT_MAX_CHARS);
    const { rule } = await store.insertRule(ctx, {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: atCaps,
      ruleKey: 'k',
      embedding: V1,
      confidence: 0.5,
    });
    expect(rule.ruleText).toBe(atCaps);
    // Exactly at the line cap → accepted too.
    const threeLines = await store.insertRule(ctx, {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: 'a\nb\nc',
      ruleKey: 'k-lines',
      embedding: vec({ 7: 1 }),
      confidence: 0.5,
    });
    expect(threeLines.rule.ruleText).toBe('a\nb\nc');
    // One char over → rejected on the personal path…
    await expect(
      store.insertRule(ctx, {
        sourceFeedbackId: fbId,
        scope: 'personal',
        ruleText: 'x'.repeat(RULE_TEXT_MAX_CHARS + 1),
        ruleKey: 'k2',
        embedding: V2,
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningRuleBoundsError);
    // …and on the gated shared path (both write paths enforce the same bounds).
    await expect(
      store.writeSharedRule(ctx, {
        sourceFeedbackId: fbId,
        ruleText: 'a\nb\nc\nd',
        ruleKey: 'k3',
        embedding: V2,
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningRuleBoundsError);
    expect(await store.loadSharedRulesForInjection(ctx)).toHaveLength(0);
  });
});

describe('LearningStore — ownership checks (F56 defence-in-depth)', () => {
  const ruleInput = (sourceFeedbackId: string) => ({
    sourceFeedbackId,
    scope: 'personal' as const,
    ruleText: 'x',
    ruleKey: 'k',
    embedding: V1,
    confidence: 0.5,
  });

  it("insertRule rejects another TENANT's sourceFeedbackId", async () => {
    const foreignFbId = await seedFeedback(ctxOf(TENANT_B));
    await expect(store.insertRule(ctxOf(TENANT_A), ruleInput(foreignFbId))).rejects.toBeInstanceOf(
      LearningOwnershipError,
    );
    expect(await store.listRules(ctxOf(TENANT_A))).toHaveLength(0);
  });

  it("insertRule rejects another ACTOR's sourceFeedbackId (same tenant)", async () => {
    const bobsFbId = await seedFeedback(ctxOf(TENANT_A, BOB));
    await expect(store.insertRule(ctxOf(TENANT_A), ruleInput(bobsFbId))).rejects.toBeInstanceOf(
      LearningOwnershipError,
    );
    expect(await store.listRules(ctxOf(TENANT_A))).toHaveLength(0);
  });

  it("writeSharedRule rejects another TENANT's sourceFeedbackId", async () => {
    const foreignFbId = await seedFeedback(ctxOf(TENANT_B));
    await expect(
      store.writeSharedRule(ctxOf(TENANT_A), {
        sourceFeedbackId: foreignFbId,
        ruleText: 'x',
        ruleKey: 'k',
        embedding: V1,
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningOwnershipError);
    expect(await store.loadSharedRulesForInjection(ctxOf(TENANT_A))).toHaveLength(0);
  });

  it("writeSharedRule ACCEPTS another actor's feedback within the tenant (proposer ≠ approving steward)", async () => {
    const proposersFbId = await seedFeedback(ctxOf(TENANT_A, ALICE));
    const { rule } = await store.writeSharedRule(ctxOf(TENANT_A, BOB), {
      sourceFeedbackId: proposersFbId, // inherited from Alice's promoted rule
      ruleText: 'x',
      ruleKey: 'k',
      embedding: V1,
      confidence: 0.5,
    });
    expect(rule.scope).toBe('shared');
    expect(rule.actor).toBe(BOB); // the approving steward
  });

  it('linkFeedbackRule rejects a rule id the caller does not own (other actor, other tenant, or nonexistent)', async () => {
    // Alice's real rule in tenant A.
    const alicesFbId = await seedFeedback(ctxOf(TENANT_A, ALICE));
    const { rule } = await store.insertRule(ctxOf(TENANT_A, ALICE), ruleInput(alicesFbId));

    // Bob (same tenant) cannot annotate his feedback with Alice's rule.
    const bobsFbId = await seedFeedback(ctxOf(TENANT_A, BOB));
    await expect(
      store.linkFeedbackRule(ctxOf(TENANT_A, BOB), bobsFbId, { ruleId: rule.id, confidence: 0.5 }),
    ).rejects.toBeInstanceOf(LearningOwnershipError);

    // Another tenant cannot reference it either; nor can anyone link a phantom id.
    const tenantBFbId = await seedFeedback(ctxOf(TENANT_B));
    await expect(
      store.linkFeedbackRule(ctxOf(TENANT_B), tenantBFbId, { ruleId: rule.id, confidence: 0.5 }),
    ).rejects.toBeInstanceOf(LearningOwnershipError);
    await expect(
      store.linkFeedbackRule(ctxOf(TENANT_A, ALICE), alicesFbId, {
        ruleId: crypto.randomUUID(),
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningOwnershipError);

    // A SHARED rule is never a valid inferredRuleId — even for its own approving
    // steward (inferredRuleId means "the personal rule inferred from this feedback").
    const shared = await store.writeSharedRule(ctxOf(TENANT_A, BOB), {
      sourceFeedbackId: bobsFbId,
      ruleText: 'x',
      ruleKey: 'k',
      embedding: V2,
      confidence: 0.5,
    });
    await expect(
      store.linkFeedbackRule(ctxOf(TENANT_A, BOB), bobsFbId, {
        ruleId: shared.rule.id,
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningOwnershipError);

    // None of the rejected links annotated a feedback row.
    const [bobsFb] = await store.listFeedback(ctxOf(TENANT_A, BOB));
    expect(bobsFb?.inferredRuleId).toBeNull();
  });
});

describe('LearningStore — dedup-reinforce', () => {
  it('reinforces a ≥0.92 near-duplicate instead of inserting a second row', async () => {
    const fbId = await seedFeedback(ctxOf(TENANT_A));
    const first = await store.insertRule(ctxOf(TENANT_A), {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: 'Prefer concise sentences.',
      ruleKey: 'tone:concise',
      embedding: V1,
      confidence: 0.7,
    });
    expect(first.reinforced).toBe(false);
    expect(first.rule.reinforcementCount).toBe(1);

    const second = await store.insertRule(ctxOf(TENANT_A), {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: 'Keep sentences short and tight.',
      ruleKey: 'tone:concise',
      embedding: V1_NEAR,
      confidence: 0.9,
    });
    expect(second.reinforced).toBe(true);
    expect(second.rule.id).toBe(first.rule.id);
    expect(second.rule.reinforcementCount).toBe(2);
    // Confidence rises toward the stronger of the two; never decreases.
    expect(second.rule.confidence).toBeCloseTo(0.9);

    // Exactly one row — the near-duplicate did not insert.
    expect(await store.listRules(ctxOf(TENANT_A))).toHaveLength(1);
  });

  it('inserts a new rule when the embedding is dissimilar', async () => {
    const fbId = await seedFeedback(ctxOf(TENANT_A));
    await store.insertRule(ctxOf(TENANT_A), {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: 'Prefer concise sentences.',
      ruleKey: 'tone:concise',
      embedding: V1,
      confidence: 0.7,
    });
    const second = await store.insertRule(ctxOf(TENANT_A), {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: 'Address the reader formally.',
      ruleKey: 'tone:formal',
      embedding: V2,
      confidence: 0.6,
    });
    expect(second.reinforced).toBe(false);
    expect(await store.listRules(ctxOf(TENANT_A))).toHaveLength(2);
  });
});

describe('LearningStore — personal isolation', () => {
  it('never leaks one actor’s rules to another, or across tenants', async () => {
    const aFb = await seedFeedback(ctxOf(TENANT_A, ALICE));
    await store.insertRule(ctxOf(TENANT_A, ALICE), {
      sourceFeedbackId: aFb,
      scope: 'personal',
      ruleText: "Alice's rule.",
      ruleKey: 'k',
      embedding: V1,
      confidence: 0.8,
    });

    // Bob in the same tenant sees nothing of Alice's.
    expect(await store.listRules(ctxOf(TENANT_A, BOB))).toHaveLength(0);
    // Alice in a different tenant sees nothing either.
    expect(await store.listRules(ctxOf(TENANT_B, ALICE))).toHaveLength(0);
    // Alice in her own (tenant, actor) sees her one rule.
    expect(await store.listRules(ctxOf(TENANT_A, ALICE))).toHaveLength(1);
  });

  it('dedup only considers the same actor — a different actor’s similar rule does not reinforce', async () => {
    const aFb = await seedFeedback(ctxOf(TENANT_A, ALICE));
    const bFb = await seedFeedback(ctxOf(TENANT_A, BOB));
    await store.insertRule(ctxOf(TENANT_A, ALICE), {
      sourceFeedbackId: aFb,
      scope: 'personal',
      ruleText: "Alice's rule.",
      ruleKey: 'k',
      embedding: V1,
      confidence: 0.8,
    });
    // Bob inserts a near-identical embedding — must be a NEW row for Bob, not a
    // reinforce of Alice's (dedup is actor-scoped).
    const bob = await store.insertRule(ctxOf(TENANT_A, BOB), {
      sourceFeedbackId: bFb,
      scope: 'personal',
      ruleText: "Bob's rule.",
      ruleKey: 'k',
      embedding: V1_NEAR,
      confidence: 0.8,
    });
    expect(bob.reinforced).toBe(false);
    expect(await store.listRules(ctxOf(TENANT_A, ALICE))).toHaveLength(1);
    expect(await store.listRules(ctxOf(TENANT_A, BOB))).toHaveLength(1);
  });
});

describe('LearningStore — shared rules (P5b, gated promotion)', () => {
  it('writeSharedRule creates a scope=shared, tenant-wide rule visible to every actor', async () => {
    // Alice's feedback is the inherited provenance for the promoted rule.
    const fbId = await seedFeedback(ctxOf(TENANT_A, ALICE));
    const { rule, reinforced } = await store.writeSharedRule(ctxOf(TENANT_A, ALICE), {
      sourceFeedbackId: fbId,
      ruleText: 'Open with the decision, then the rationale.',
      ruleKey: 'structure:decision-first',
      embedding: V1,
      confidence: 0.8,
    });
    expect(reinforced).toBe(false);
    expect(rule.scope).toBe('shared');

    // Tenant-wide: Bob (a DIFFERENT actor in the same tenant) sees the shared rule.
    const bobShared = await store.loadSharedRulesForInjection(ctxOf(TENANT_A, BOB));
    expect(bobShared).toHaveLength(1);
    expect(bobShared[0]?.id).toBe(rule.id);

    // A shared rule is NOT a personal rule: it never appears in listRules (which
    // is scope='personal' + actor-scoped), for Alice or Bob.
    expect(await store.listRules(ctxOf(TENANT_A, ALICE))).toHaveLength(0);
    expect(await store.listRules(ctxOf(TENANT_A, BOB))).toHaveLength(0);

    // Tenant isolation: tenant B sees no shared rule of tenant A.
    expect(await store.loadSharedRulesForInjection(ctxOf(TENANT_B, ALICE))).toHaveLength(0);
  });

  it('writeSharedRule is provenance-gated (no sourceFeedbackId → rejected)', async () => {
    await expect(
      store.writeSharedRule(ctxOf(TENANT_A), {
        sourceFeedbackId: '',
        ruleText: 'x',
        ruleKey: 'k',
        embedding: V1,
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(LearningProvenanceError);
    expect(await store.loadSharedRulesForInjection(ctxOf(TENANT_A))).toHaveLength(0);
  });

  it('dedup-reinforces a ≥0.92 near-duplicate shared rule TENANT-WIDE (any approver)', async () => {
    const aliceFb = await seedFeedback(ctxOf(TENANT_A, ALICE));
    const bobFb = await seedFeedback(ctxOf(TENANT_A, BOB));
    const first = await store.writeSharedRule(ctxOf(TENANT_A, ALICE), {
      sourceFeedbackId: aliceFb,
      ruleText: 'Open with the decision.',
      ruleKey: 'structure:decision-first',
      embedding: V1,
      confidence: 0.7,
    });
    // A DIFFERENT steward (Bob) promotes a near-identical rule → reinforces the
    // SAME shared row (dedup is tenant-wide, not actor-scoped).
    const second = await store.writeSharedRule(ctxOf(TENANT_A, BOB), {
      sourceFeedbackId: bobFb,
      ruleText: 'Lead with the decision, then why.',
      ruleKey: 'structure:decision-first',
      embedding: V1_NEAR,
      confidence: 0.9,
    });
    expect(second.reinforced).toBe(true);
    expect(second.rule.id).toBe(first.rule.id);
    expect(second.rule.reinforcementCount).toBe(2);
    expect(second.rule.confidence).toBeCloseTo(0.9);
    expect(await store.loadSharedRulesForInjection(ctxOf(TENANT_A))).toHaveLength(1);
  });

  it('a dissimilar shared rule inserts a new row; shared and personal coexist independently', async () => {
    const fbId = await seedFeedback(ctxOf(TENANT_A, ALICE));
    // One personal rule for Alice (axis 0) ...
    await store.insertRule(ctxOf(TENANT_A, ALICE), {
      sourceFeedbackId: fbId,
      scope: 'personal',
      ruleText: 'Alice prefers short sentences.',
      ruleKey: 'tone:concise',
      embedding: V1,
      confidence: 0.7,
    });
    // ... and two dissimilar shared rules (axis 0 and orthogonal axis 5).
    await store.writeSharedRule(ctxOf(TENANT_A, ALICE), {
      sourceFeedbackId: fbId,
      ruleText: 'Open with the decision.',
      ruleKey: 'structure:decision-first',
      embedding: V1,
      confidence: 0.8,
    });
    const second = await store.writeSharedRule(ctxOf(TENANT_A, ALICE), {
      sourceFeedbackId: fbId,
      ruleText: 'Address the reader formally.',
      ruleKey: 'tone:formal',
      embedding: V2,
      confidence: 0.6,
    });
    expect(second.reinforced).toBe(false);
    // Two shared rows tenant-wide; Alice still has exactly her one personal rule.
    expect(await store.loadSharedRulesForInjection(ctxOf(TENANT_A))).toHaveLength(2);
    expect(await store.listRules(ctxOf(TENANT_A, ALICE))).toHaveLength(1);
  });
});

describe('LearningStore — style profile', () => {
  it('upserts a single profile in place, actor-scoped', async () => {
    expect(await store.getStyleProfile(ctxOf(TENANT_A))).toBeNull();
    const first = await store.upsertStyleProfile(ctxOf(TENANT_A), 'Writes in plain English.');
    const second = await store.upsertStyleProfile(
      ctxOf(TENANT_A),
      'Writes in plain English; concise.',
    );
    expect(second.id).toBe(first.id); // overwritten in place — same row
    expect(second.profileText).toContain('concise');

    const profile = await store.getStyleProfile(ctxOf(TENANT_A));
    expect(profile?.profileText).toContain('concise');
    // Bob has his own (empty) profile space.
    expect(await store.getStyleProfile(ctxOf(TENANT_A, BOB))).toBeNull();
  });
});
