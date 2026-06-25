// QueryAuditor against the real model — verifies the semantic faithfulness
// judge returns sane verdicts on a clearly-supported and a clearly-unsupported
// claim. Gated on the Anthropic key; runs under `pnpm test:providers`.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import { asDocumentId, asParagraphId, asTenantId } from '../graph/types';
import { AnthropicLLMProvider } from '../providers';
import { QueryAuditor } from './query-auditor';
import type { QueryResult } from './types';

const hasAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim();

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-00000000a17e');
const PARA = asParagraphId('00000000-0000-0000-0000-00000000a17a');
const DOC = asDocumentId('00000000-0000-0000-0000-00000000a17d');

beforeAll(async () => {
  if (!hasAnthropic) return;
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'auditor-test' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

describe.skipIf(!hasAnthropic)('QueryAuditor — real model', () => {
  const PARA_TEXT =
    'The Apollo project is led by Sarah Jones and is scheduled to ship in the third quarter of 2026.';

  function result(answer: string): QueryResult {
    return {
      status: 'answered',
      answer,
      citations: [{ marker: 1, paragraphId: PARA, documentId: DOC, quote: 'led by Sarah Jones' }],
    };
  }

  it('judges a supported claim faithful and an unsupported claim unfaithful', async () => {
    const auditor = new QueryAuditor({
      llmProvider: new AnthropicLLMProvider({
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        defaultModel: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
      }),
      graphStore: store,
    });

    const supported = await auditor.audit({
      tenantId: TENANT,
      question: 'Who leads Apollo?',
      result: result('Apollo is led by Sarah Jones [1].'),
      paragraphText: new Map([[PARA, PARA_TEXT]]),
    });
    expect(supported.faithfulnessScore).toBe(1);

    const unsupported = await auditor.audit({
      tenantId: TENANT,
      question: 'What is the budget?',
      result: result('The Apollo project budget is two million pounds [1].'),
      paragraphText: new Map([[PARA, PARA_TEXT]]),
    });
    expect(unsupported.faithfulnessScore).toBe(0);
  }, 60_000);

  // G2 JUDGE VALIDATION — the auditor metric is only trustworthy if the judge
  // itself is. Prove it over KNOWN-FAITHFUL and KNOWN-UNFAITHFUL (source, claim)
  // pairs covering the failure modes the prompt names (ADD / OVERSTATE /
  // CONTRADICT / UNRELATED). The judge must FLAG every unfaithful and PASS every
  // faithful. Fixtures are GENERIC project/person prose — no vertical concept.
  const JUDGE_CASES: ReadonlyArray<{
    id: string;
    source: string;
    claim: string;
    expectedSupported: boolean;
  }> = [
    {
      id: 'faithful/verbatim',
      source:
        'The review concluded that the proposal was partially approved on the technical element.',
      claim: 'The proposal was partially approved on the technical element.',
      expectedSupported: true,
    },
    {
      id: 'faithful/paraphrase',
      source: 'A formal notice was issued, to remain in effect for twelve months.',
      claim: 'The outcome was a formal notice lasting 12 months.',
      expectedSupported: true,
    },
    {
      id: 'faithful/direct-inference',
      source: 'The end-of-trial review recommends the item be confirmed for full rollout.',
      claim: 'The trial was passed.',
      expectedSupported: true,
    },
    {
      id: 'unfaithful/fabricated',
      source: 'The meeting was held on 14 January and the matter was discussed at length.',
      claim: 'The proposal was rejected outright for non-compliance.',
      expectedSupported: false,
    },
    {
      id: 'unfaithful/overstated',
      source: 'There were some concerns raised about timing on two occasions.',
      claim: 'There is a long and serious history of persistent delays.',
      expectedSupported: false,
    },
    {
      id: 'unfaithful/contradicted',
      source: 'The allegation was not upheld; the panel accepted it was a genuine error.',
      claim: 'The panel found the conduct had been deliberate.',
      expectedSupported: false,
    },
    {
      id: 'unfaithful/unrelated',
      source: 'The car park resurfacing works are scheduled for the February break.',
      claim: 'The outage was caused by a supply shortage.',
      expectedSupported: false,
    },
  ];

  it('VALIDATE THE JUDGE: flags every unfaithful sample and passes every faithful one', async () => {
    const auditor = new QueryAuditor({
      llmProvider: new AnthropicLLMProvider({
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        defaultModel: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
      }),
      graphStore: store,
    });

    const outcomes: { id: string; expected: boolean; got: boolean }[] = [];
    for (const c of JUDGE_CASES) {
      // The citation marker must sit INSIDE the claim sentence (before the
      // terminal period), mirroring real answers — otherwise extractClaim
      // isolates a bare "[1]" with no content to judge.
      const answer = `${c.claim.replace(/\.\s*$/, '')} [1].`;
      const audit = await auditor.audit({
        tenantId: TENANT,
        question: 'validation',
        result: {
          status: 'answered',
          answer,
          citations: [{ marker: 1, paragraphId: PARA, documentId: DOC, quote: c.claim }],
        },
        paragraphText: new Map([[PARA, c.source]]),
      });
      outcomes.push({
        id: c.id,
        expected: c.expectedSupported,
        got: audit.verdicts[0]?.supported ?? false,
      });
    }

    // The hard bar: ZERO unfaithful passed (the catastrophic miss) AND zero
    // faithful wrongly flagged. Reported per-case so a failure names the case.
    const wrong = outcomes.filter((o) => o.got !== o.expected);
    expect(wrong, `misclassified: ${wrong.map((w) => w.id).join(', ')}`).toEqual([]);
  }, 180_000);
});
