// F44 model-quality measurement — local tool_use extraction through Ollama.
//
// Gated on a REACHABLE local Ollama daemon (skipIf, sanctioned by the
// *.providers.test.ts naming); measures, per pulled candidate model, how well
// a small local model drives the tool_use extraction discipline. There is NO
// pass bar to game: the structural assertions only require honest accounting
// (every paragraph lands in exactly one of extracted/skipped/errors; anything
// persisted carries document_extract provenance). The DELIVERABLE is the
// printed report — paragraphs extracted vs skipped, repair-retry count,
// entities written and their verbatim-confidence rate — which feeds the
// recommended-models note in the local-runtime notes.
//
// Ollama has NO forced-tool-choice parameter, so the engine's toolChoice is
// best-effort here: a model that answers in prose instead of calling the tool
// produces an honest skip (or a repair retry), never a crash — that behaviour
// is exactly what this suite quantifies.
//
// Candidate models come from MUNIN_OLLAMA_EXTRACT_MODELS (comma-separated) or
// the default list below, filtered to what the daemon actually has pulled.
// Store: in-memory PGlite — no Docker, no network beyond the loopback daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tenants } from '../db/schema';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import {
  type DocumentId,
  type ParagraphId,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
  newParagraphId,
} from '../graph/types';
import { OllamaLLMProvider } from '../providers';
import { sampleConfiguration } from '../test-support/sample-configuration';
import { InlineExtractRunner } from './local-extract-runner';

const BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const CANDIDATES = (process.env.MUNIN_OLLAMA_EXTRACT_MODELS ?? 'llama3.1:8b,qwen2.5:7b,llama3.2:3b')
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m.length > 0);
// Per-call timeout. CPU/Metal prompt-eval of the (large) extraction prefix is
// the slow part; 120s proved too tight when the daemon is under any other
// load, so default generously and let operators tune.
const CALL_TIMEOUT_MS = Number(process.env.MUNIN_OLLAMA_EXTRACT_TIMEOUT_MS ?? '300000');

// Probe the daemon and intersect the candidate list with the pulled models.
async function pulledCandidates(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const pulled = new Set((body.models ?? []).map((m) => m.name ?? ''));
    return CANDIDATES.filter((c) => pulled.has(c));
  } catch {
    return [];
  }
}

const MODELS = await pulledCandidates();

// Six-paragraph synthetic generic corpus (Projects/Tasks/People — the same
// shape the sampleConfiguration's few-shots teach). Mixed difficulty: clean
// single-entity statements, a relationship, an entity-free paragraph.
const CORPUS: readonly string[] = [
  'The Atlas project kicked off in March 2026. Sarah Chen is responsible for delivery.',
  'The Borealis project remains in planning while the team finalises its scope.',
  'Update the onboarding checklist before the next intake. The task is assigned to Priya Patel and due on 2026-07-01.',
  'Marcus Webb joined as a data engineer and reports to Sarah Chen.',
  'The quarterly review noted that Atlas is on track and Borealis needs a sponsor.',
  'No decisions were taken at the stand-up; the agenda moves to next week.',
];

const ACTOR = asActorId('ollama-extract-smoke');
const TAGS = ['t:smoke'];

let handle: PgliteGraphStoreHandle;

beforeAll(async () => {
  if (MODELS.length === 0) return;
  handle = await createPgliteGraphStore({}); // in-memory PGlite
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function seedTenantCorpus(
  tenantId: TenantId,
): Promise<{ docId: DocumentId; paragraphIds: ParagraphId[] }> {
  const wctx: WriteContext = { tenantId, actor: ACTOR };
  await handle.db.insert(tenants).values({ id: tenantId, name: `smoke-${tenantId.slice(0, 8)}` });
  const doc = await handle.store.insertDocument(wctx, {
    title: 'synthetic-notes.md',
    blobStorageUri: 'mem://synthetic-notes',
    accessTags: TAGS,
  });
  const paragraphIds: ParagraphId[] = [];
  await handle.store.insertParagraphsBulk(
    wctx,
    CORPUS.map((text, i) => {
      const id = newParagraphId();
      paragraphIds.push(id);
      return { id, documentId: doc.id, paragraphIndex: i, text, accessTags: TAGS };
    }),
  );
  return { docId: doc.id, paragraphIds };
}

describe.skipIf(MODELS.length === 0)(
  'F44 measurement — Ollama tool_use extraction quality (local models)',
  () => {
    it.each(MODELS)(
      'measures extraction quality on %s (no pass bar — honest numbers)',
      async (model) => {
        // Fresh tenant per model so per-model provenance/confidence reads are
        // isolated (a shared tenant would mix extractor versions).
        const tenantId = asTenantId(crypto.randomUUID());
        const { paragraphIds } = await seedTenantCorpus(tenantId);

        // Warm the model first (Ollama loads it on first use) so cold-load
        // time is not billed to the first paragraph's call timeout.
        await fetch(`${BASE_URL}/api/chat`, {
          method: 'POST',
          body: JSON.stringify({
            model,
            stream: false,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
          }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });

        const llm = new OllamaLLMProvider({
          baseUrl: BASE_URL,
          defaultModel: model,
          timeoutMs: CALL_TIMEOUT_MS,
        });
        const runner = new InlineExtractRunner({
          graphStore: handle.store,
          llmProvider: llm,
          configuration: sampleConfiguration,
          modelId: model,
        });

        const started = Date.now();
        const summary = await runner.run([{ tenantId, paragraphIds }]);
        const elapsedMs = Date.now() - started;

        // Everything persisted must be a real graph row with provenance,
        // visible to a permissioned read.
        const regular: ReadContext = {
          kind: 'regular',
          tenantId,
          accessTags: TAGS,
          actor: ACTOR,
        };
        const page = await handle.store.findEntities(regular, { limit: 200 });
        let withProvenance = 0;
        let verbatim = 0;
        for (const entity of page.items) {
          if (entity.provenance.kind === 'document_extract') {
            withProvenance++;
            if (entity.provenance.confidence === 1) verbatim++;
          }
        }

        // The deliverable: the honest numbers.
        console.log(
          JSON.stringify(
            {
              model,
              paragraphs: paragraphIds.length,
              extracted: summary.extracted,
              skipped: summary.skipped,
              errors: summary.errors,
              repairsUsed: summary.repairsUsed,
              stringifiedArraysParsed: summary.stringifiedArraysParsed,
              entitiesWritten: summary.entitiesWritten,
              edgesWritten: summary.edgesWritten,
              entitiesWithValidProvenance: withProvenance,
              entitiesVerbatimConfidence: verbatim,
              elapsedMs,
            },
            null,
            2,
          ),
        );

        // Structural honesty only — no quality threshold.
        expect(summary.extracted + summary.skipped + summary.errors.length).toBe(
          paragraphIds.length,
        );
        expect(withProvenance).toBe(page.items.length);
        expect(summary.entitiesWritten).toBe(page.items.length);
      },
      3_600_000, // CPU inference is slow; one call (two with repair) per paragraph
    );
  },
);
