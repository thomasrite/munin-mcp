// Integration tests for the data-retention sweep (G2a: F55) against REAL Postgres.
//
// Proves the scrub-in-place contract:
//   - only PAST-TTL rows are scrubbed: content NULLed + content_scrubbed_at set
//   - metadata + rule linkage survive the scrub (the FK'd rule keeps pointing at
//     the scrubbed row; decision/context/scope are untouched)
//   - unexpired rows are untouched; already-scrubbed rows are not re-stamped
//   - tenant-scoped: another tenant's expired rows are untouched
//   - ONE content-free audit row per run (counts + cutoffs, never content)
//   - idempotent: a second run scrubs zero
//   - listFeedback round-trips a scrubbed row honestly (NULL content, marker set)

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { learnedRules, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import { type TenantId, asActorId, asTenantId } from '../graph/types';
import { LearningStore } from '../learning/learning-store';
import type { LearningContext } from '../learning/types';

import { retentionCutoff, runRetentionSweep } from './retention-sweep';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: LearningStore;
let graph: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000aa');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000bb');
const ALICE = asActorId('alice');
const SWEEPER = asActorId('system:retention-sweep');

const ctxOf = (tenantId: TenantId, actor = ALICE): LearningContext => ({ tenantId, actor });

const DAY_MS = 86_400_000;
const now = () => new Date();
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

function vec(overrides: Record<number, number>): number[] {
  const v = Array.from({ length: 1024 }, () => 0);
  for (const [i, value] of Object.entries(overrides)) v[Number(i)] = value;
  return v;
}

// Record one feedback row, then backdate its created_at (created_at is
// DB-defaulted, so age is injected after the fact — content is synthetic).
async function seedFeedbackAged(ctx: LearningContext, createdDaysAgo: number): Promise<string> {
  const fb = await store.recordFeedback(ctx, {
    context: { templateId: 't1' },
    modelDraft: 'Munin drafted this.',
    humanFinal: 'The human shortened this.',
    decision: 'edit',
    scope: 'personal',
  });
  await db.execute(
    sql`UPDATE generation_feedback
        SET created_at = ${daysAgo(createdDaysAgo).toISOString()}::timestamptz
        WHERE id = ${fb.id}`,
  );
  return fb.id;
}

async function auditRows(): Promise<Array<Record<string, unknown>>> {
  const res = await db.execute(
    sql`SELECT tenant_id, actor, action, target_kind, target_id, access_tags_used, details
        FROM audit_events WHERE action = 'retention_sweep' ORDER BY created_at, id`,
  );
  return [...res] as Array<Record<string, unknown>>;
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
  graph = new PostgresGraphStore(db);
}, 120_000);

afterEach(async () => {
  // Order matters: learned_rules FKs generation_feedback.
  await db.delete(learnedRules);
  await db.execute(sql`DELETE FROM generation_feedback`);
  await db.execute(sql`DELETE FROM review_queue`);
  await db.execute(sql`DELETE FROM audit_events`);
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

describe('runRetentionSweep — feedback content scrub (F55)', () => {
  it('scrubs only past-TTL rows: content NULL + marker set; metadata + rule link survive', async () => {
    const ctx = ctxOf(TENANT_A);
    const expiredId = await seedFeedbackAged(ctx, 100);
    const freshId = await seedFeedbackAged(ctx, 5);
    // An expired row REFERENCED BY A RULE — the FK (ON DELETE restrict) means
    // scrub-in-place is the only legal retention move; prove the link survives.
    const linkedId = await seedFeedbackAged(ctx, 120);
    const { rule } = await store.insertRule(ctx, {
      sourceFeedbackId: linkedId,
      scope: 'personal',
      ruleText: 'Prefer concise sentences.',
      ruleKey: 'tone',
      embedding: vec({ 0: 1 }),
      confidence: 0.8,
    });
    // Another tenant's expired row must be untouched (tenant scoping).
    const otherTenantId = await seedFeedbackAged(ctxOf(TENANT_B), 100);

    const result = await runRetentionSweep(
      db,
      { tenantId: TENANT_A, actor: SWEEPER },
      { feedbackCutoff: retentionCutoff(90, now()), reviewCutoff: retentionCutoff(90, now()) },
    );
    expect(result.feedbackScrubbed).toBe(2);

    const mine = await store.listFeedback(ctx);
    const byId = new Map(mine.map((f) => [f.id, f]));

    // Scrubbed: content gone, marker set, skeleton intact.
    for (const id of [expiredId, linkedId]) {
      const f = byId.get(id);
      expect(f?.modelDraft).toBeNull();
      expect(f?.humanFinal).toBeNull();
      expect(f?.contentScrubbedAt).toBeInstanceOf(Date);
      expect(f?.decision).toBe('edit');
      expect(f?.context).toEqual({ templateId: 't1' });
      expect(f?.scope).toBe('personal');
    }
    // Fresh: untouched.
    expect(byId.get(freshId)?.modelDraft).toBe('Munin drafted this.');
    expect(byId.get(freshId)?.contentScrubbedAt).toBeNull();
    // The rule survives, still provenance-linked to the scrubbed row.
    const rules = await store.listRules(ctx);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe(rule.id);
    expect(rules[0]?.sourceFeedbackId).toBe(linkedId);
    // The other tenant's expired row is untouched.
    const theirs = await store.listFeedback(ctxOf(TENANT_B));
    expect(theirs[0]?.id).toBe(otherTenantId);
    expect(theirs[0]?.modelDraft).toBe('Munin drafted this.');
    expect(theirs[0]?.contentScrubbedAt).toBeNull();
  });

  it('writes ONE content-free audit row per run (counts + cutoff only)', async () => {
    const ctx = ctxOf(TENANT_A);
    await seedFeedbackAged(ctx, 100);

    const cutoff = retentionCutoff(90, now());
    await runRetentionSweep(
      db,
      { tenantId: TENANT_A, actor: SWEEPER },
      { feedbackCutoff: cutoff, reviewCutoff: cutoff },
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.tenant_id).toBe(TENANT_A);
    expect(row?.actor).toBe('system:retention-sweep');
    expect(row?.target_kind).toBe('tenant');
    expect(row?.target_id).toBe(TENANT_A);
    expect(row?.access_tags_used).toEqual([]);
    // Counts + cutoffs only — assert the exact key set so content can never ride.
    const details = row?.details as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual([
      'feedbackCutoff',
      'feedbackScrubbed',
      'reviewCutoff',
      'reviewItemsScrubbed',
    ]);
    expect(details.feedbackScrubbed).toBe(1);
    expect(details.feedbackCutoff).toBe(cutoff.toISOString());
    expect(details.reviewItemsScrubbed).toBe(0);
  });

  it('is atomic: a failed audit write rolls the scrub back — no partial state', async () => {
    const ctx = ctxOf(TENANT_A);
    const expiredId = await seedFeedbackAged(ctx, 100);

    // Force the in-tx audit insert to fail, proving the one-transaction claim:
    // "the audit trail can never claim a sweep that didn't happen (and vice
    // versa)" — a sweep whose audit row cannot land must scrub nothing.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_retention_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'retention_sweep' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER retention_audit_fails BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION fail_retention_audit();
    `);
    try {
      await expect(
        runRetentionSweep(
          db,
          { tenantId: TENANT_A, actor: SWEEPER },
          { feedbackCutoff: retentionCutoff(90, now()), reviewCutoff: retentionCutoff(90, now()) },
        ),
        // Drizzle wraps the PG exception in a failed-query error naming the
        // audit insert; the trigger's own message rides in the cause.
      ).rejects.toThrow(/audit_events|audit unavailable/);
    } finally {
      await db.execute(sql`
        DROP TRIGGER retention_audit_fails ON audit_events;
        DROP FUNCTION fail_retention_audit();
      `);
    }

    // The scrub rolled back with the audit failure: content intact, no marker.
    const row = (await store.listFeedback(ctx)).find((f) => f.id === expiredId);
    expect(row?.modelDraft).toBe('Munin drafted this.');
    expect(row?.humanFinal).toBe('The human shortened this.');
    expect(row?.contentScrubbedAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('F54: scrubs RESOLVED review items past the TTL; pending items are NEVER aged out', async () => {
    const writeCtx = { tenantId: TENANT_A, actor: ALICE };
    const stewardCtx = { tenantId: TENANT_A, actor: asActorId('steward') };
    const enqueue = (note: string) =>
      graph.enqueueReviewItem(writeCtx, {
        targetKind: 'entity',
        targetId: crypto.randomUUID(),
        proposedChange: { kind: 'correction', value: 'suggester-typed text' },
        accessTags: ['team:a'],
        note,
      });
    const backdateReview = (id: string, days: number) =>
      db.execute(
        sql`UPDATE review_queue
            SET reviewed_at = ${daysAgo(days).toISOString()}::timestamptz
            WHERE id = ${id}`,
      );

    // Another tenant's old resolved item must survive a TENANT_A sweep.
    const otherTenantItem = await graph.enqueueReviewItem(
      { tenantId: TENANT_B, actor: ALICE },
      {
        targetKind: 'entity',
        targetId: crypto.randomUUID(),
        proposedChange: { kind: 'correction', value: 'other tenant text' },
        accessTags: ['team:b'],
        note: 'other tenant note',
      },
    );
    await graph.resolveReviewItem(
      { tenantId: TENANT_B, actor: asActorId('steward') },
      otherTenantItem.id,
      {
        decision: 'approved',
      },
    );
    await backdateReview(otherTenantItem.id, 120);

    // Resolved long ago → scrubbed. Resolved recently → kept. Pending forever-old → kept.
    const oldApproved = await enqueue('old approved note');
    await graph.resolveReviewItem(stewardCtx, oldApproved.id, { decision: 'approved' });
    await backdateReview(oldApproved.id, 120);
    const oldRejected = await enqueue('old rejected note');
    await graph.resolveReviewItem(stewardCtx, oldRejected.id, { decision: 'rejected' });
    await backdateReview(oldRejected.id, 120);
    const freshResolved = await enqueue('fresh resolved note');
    await graph.resolveReviewItem(stewardCtx, freshResolved.id, { decision: 'approved' });
    const ancientPending = await enqueue('ancient pending note');
    await db.execute(
      sql`UPDATE review_queue SET created_at = ${daysAgo(400).toISOString()}::timestamptz
          WHERE id = ${ancientPending.id}`,
    );

    const result = await runRetentionSweep(
      db,
      { tenantId: TENANT_A, actor: SWEEPER },
      { feedbackCutoff: retentionCutoff(90, now()), reviewCutoff: retentionCutoff(90, now()) },
    );
    expect(result.reviewItemsScrubbed).toBe(2);

    const rows = [
      ...(await db.execute(
        sql`SELECT id, status, proposed_change, note, reviewed_by, reviewed_at
            FROM review_queue ORDER BY created_at`,
      )),
    ] as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The two old resolved items: payload + note gone, the decision trail intact.
    for (const item of [oldApproved, oldRejected]) {
      const r = byId.get(item.id);
      expect(r?.proposed_change).toEqual({});
      expect(r?.note).toBeNull();
      expect(r?.reviewed_by).toBe('steward');
      // Raw SQL returns timestamptz as a string — non-null is the assertion.
      expect(r?.reviewed_at).toBeTruthy();
    }
    expect(byId.get(oldApproved.id)?.status).toBe('approved');
    expect(byId.get(oldRejected.id)?.status).toBe('rejected');
    // The fresh resolved item keeps its payload until ITS TTL passes.
    expect(byId.get(freshResolved.id)?.proposed_change).toEqual({
      kind: 'correction',
      value: 'suggester-typed text',
    });
    // The ancient PENDING item is untouched — pending is never aged out silently.
    expect(byId.get(ancientPending.id)?.status).toBe('pending');
    expect(byId.get(ancientPending.id)?.note).toBe('ancient pending note');
    // TENANT B's old resolved item is untouched (tenant scoping).
    expect(byId.get(otherTenantItem.id)?.note).toBe('other tenant note');
    expect(byId.get(otherTenantItem.id)?.proposed_change).toEqual({
      kind: 'correction',
      value: 'other tenant text',
    });

    // Idempotent: the content predicate stops re-matching scrubbed rows.
    const again = await runRetentionSweep(
      db,
      { tenantId: TENANT_A, actor: SWEEPER },
      { feedbackCutoff: retentionCutoff(90, now()), reviewCutoff: retentionCutoff(90, now()) },
    );
    expect(again.reviewItemsScrubbed).toBe(0);
  });

  it('is idempotent: a second run scrubs zero and never re-stamps the marker', async () => {
    const ctx = ctxOf(TENANT_A);
    const expiredId = await seedFeedbackAged(ctx, 100);

    const first = await runRetentionSweep(
      db,
      { tenantId: TENANT_A, actor: SWEEPER },
      { feedbackCutoff: retentionCutoff(90, now()), reviewCutoff: retentionCutoff(90, now()) },
    );
    expect(first.feedbackScrubbed).toBe(1);
    const stampedAt = (await store.listFeedback(ctx)).find(
      (f) => f.id === expiredId,
    )?.contentScrubbedAt;
    expect(stampedAt).toBeInstanceOf(Date);

    const second = await runRetentionSweep(
      db,
      { tenantId: TENANT_A, actor: SWEEPER },
      { feedbackCutoff: retentionCutoff(90, now()), reviewCutoff: retentionCutoff(90, now()) },
    );
    expect(second.feedbackScrubbed).toBe(0);
    // The original scrub timestamp is preserved (the marker is the idempotency key).
    const after = (await store.listFeedback(ctx)).find((f) => f.id === expiredId);
    expect(after?.contentScrubbedAt?.getTime()).toBe(stampedAt?.getTime());
    // Both runs are honestly audited (the zero-count run too).
    expect(await auditRows()).toHaveLength(2);
  });
});
