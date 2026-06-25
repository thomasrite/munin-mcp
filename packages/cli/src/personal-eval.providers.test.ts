// Extraction-quality eval for @muninhq/config-personal (prosumer step 4) —
// the live legs of the package's in-repo eval (corpus + ground truth + scorer
// live in @muninhq/config-personal/eval; this suite spends tokens, so it is
// providers-gated and excluded from the default `pnpm test`).
//
//   • Cloud leg (primary numbers): Haiku over the 9-document synthetic
//     corpus, gated on ANTHROPIC_API_KEY.
//   • Local leg: the same corpus on a local Ollama daemon (qwen2.5:7b — the
//     recommended local model, F63), gated on a reachable daemon with the
//     model pulled. Extends the F44 measurement pattern
//     (engine/src/jobs/local-extract-ollama.providers.test.ts).
//
// There is NO pass bar to game: structural assertions require honest
// accounting only (every paragraph lands in exactly one outcome bucket). The
// DELIVERABLE is the printed scorecard — entity/relationship precision +
// recall against the hand-authored manifest, plus shim fires, repairs, and
// token spend — which feeds EVAL-FINDINGS.md in the config package.
//
// Store: PGlite in a temp dir — no Docker, no network beyond the chosen
// provider. Reads use a REGULAR context under the owner role's tags, so the
// run also proves the role-tag ↔ ingest-tag alignment end-to-end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import personalConfiguration from '@muninhq/config-personal';
import {
  type ExtractedEntityLike,
  type ExtractedRelationshipLike,
  paragraphsOf,
  personalEvalCorpus,
  scoreExtraction,
} from '@muninhq/config-personal/eval';
import {
  AnthropicLLMProvider,
  DEV_HAIKU_MODEL,
  type Entity,
  type LLMProvider,
  OllamaLLMProvider,
  type ParagraphId,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
  newParagraphId,
} from '@muninhq/engine';
import { llmCalls, tenants } from '@muninhq/engine/db/schema';
import { type GraphStoreHandle, loadGraphStore } from '@muninhq/engine/graph-store';
import { InlineExtractRunner } from '@muninhq/engine/jobs';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

const ACTOR = asActorId('personal-eval');
// The tag local:init's printed ingest command writes — also the owner role's
// base tag (the alignment the cross-check test pins).
const TAGS = ['personal'];

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? '';

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(
  /\/$/,
  '',
);
const LOCAL_MODEL = process.env.MUNIN_PERSONAL_EVAL_LOCAL_MODEL ?? 'qwen2.5:7b';
const LOCAL_CALL_TIMEOUT_MS = Number(process.env.MUNIN_OLLAMA_EXTRACT_TIMEOUT_MS ?? '300000');

async function localModelAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).some((m) => m.name === LOCAL_MODEL);
  } catch {
    return false;
  }
}

const LOCAL_AVAILABLE = await localModelAvailable();

const tempDirs: string[] = [];
const handles: GraphStoreHandle[] = [];

afterAll(async () => {
  for (const handle of handles) await handle.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Minimal structural view over the PGlite/postgres-js Drizzle union (the
// sanctioned local-init pattern — the chained query shape is identical).
interface EvalDb {
  insert(table: typeof tenants): { values(row: { id: string; name: string }): Promise<unknown> };
  select(fields: {
    inputTokens: typeof llmCalls.inputTokens;
    cachedInputTokens: typeof llmCalls.cachedInputTokens;
    outputTokens: typeof llmCalls.outputTokens;
    costEstimatePence: typeof llmCalls.costEstimatePence;
  }): {
    from(table: typeof llmCalls): {
      where(condition: unknown): Promise<
        Array<{
          inputTokens: number;
          cachedInputTokens: number;
          outputTokens: number;
          costEstimatePence: bigint | null;
        }>
      >;
    };
  };
}

interface EvalRunResult {
  readonly score: ReturnType<typeof scoreExtraction>;
  readonly summary: Awaited<ReturnType<InlineExtractRunner['run']>>;
  readonly entityRows: number;
  readonly paragraphs: number;
}

async function runEval(label: string, llm: LLMProvider, modelId: string): Promise<EvalRunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-personal-eval-'));
  tempDirs.push(dir);
  const handle = await loadGraphStore({
    GRAPH_STORE: 'local',
    PGLITE_DATA_DIR: dir,
  } as NodeJS.ProcessEnv);
  handles.push(handle);

  const tenantId: TenantId = asTenantId(crypto.randomUUID());
  const db = handle.db as unknown as EvalDb;
  await db.insert(tenants).values({ id: tenantId, name: `personal-eval-${label}` });

  // Seed the corpus exactly as ingestion would store it: one document per
  // corpus file, blank-line-split paragraphs, tagged 'personal'.
  const wctx: WriteContext = { tenantId, actor: ACTOR };
  const paragraphIds: ParagraphId[] = [];
  for (const doc of personalEvalCorpus) {
    const inserted = await handle.store.insertDocument(wctx, {
      title: doc.file,
      blobStorageUri: `mem://personal-eval/${doc.file}`,
      accessTags: TAGS,
    });
    await handle.store.insertParagraphsBulk(
      wctx,
      paragraphsOf(doc).map((text, i) => {
        const id = newParagraphId();
        paragraphIds.push(id);
        return { id, documentId: inserted.id, paragraphIndex: i, text, accessTags: TAGS };
      }),
    );
  }

  const runner = new InlineExtractRunner({
    graphStore: handle.store,
    llmProvider: llm,
    configuration: personalConfiguration,
    modelId,
  });
  const started = Date.now();
  const summary = await runner.run([{ tenantId, paragraphIds }]);
  const elapsedMs = Date.now() - started;

  // Read back under the owner role's tags — a REGULAR permissioned read, so
  // the eval also proves the printed ingest tag is readable by the role.
  const rctx: ReadContext = { kind: 'regular', tenantId, accessTags: TAGS, actor: ACTOR };
  const entityPage = await handle.store.findEntities(rctx, { limit: 10_000 });
  const edgePage = await handle.store.findEdges(rctx, { limit: 10_000 });

  const byId = new Map<string, Entity>(entityPage.items.map((e) => [e.id, e]));
  const extractedEntities: ExtractedEntityLike[] = entityPage.items.map((e) => ({
    type: e.type,
    properties: e.properties,
  }));
  const extractedRelationships: ExtractedRelationshipLike[] = edgePage.items.flatMap((edge) => {
    const from = byId.get(edge.fromEntityId);
    const to = byId.get(edge.toEntityId);
    if (!from || !to) return [];
    return [
      {
        type: edge.type,
        from: { type: from.type, properties: from.properties },
        to: { type: to.type, properties: to.properties },
      },
    ];
  });

  const score = scoreExtraction({
    entities: extractedEntities,
    relationships: extractedRelationships,
  });

  const spendRows = await db
    .select({
      inputTokens: llmCalls.inputTokens,
      cachedInputTokens: llmCalls.cachedInputTokens,
      outputTokens: llmCalls.outputTokens,
      costEstimatePence: llmCalls.costEstimatePence,
    })
    .from(llmCalls)
    .where(eq(llmCalls.tenantId, tenantId));
  const spend = spendRows.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + r.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + r.cachedInputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      costEstimatePence: acc.costEstimatePence + Number(r.costEstimatePence ?? 0n),
    }),
    { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costEstimatePence: 0 },
  );

  // The deliverable: the honest scorecard.
  console.log(
    JSON.stringify(
      {
        leg: label,
        model: modelId,
        paragraphs: paragraphIds.length,
        extracted: summary.extracted,
        skipped: summary.skipped,
        errors: summary.errors,
        repairsUsed: summary.repairsUsed,
        stringifiedArraysParsed: summary.stringifiedArraysParsed,
        entityRows: entityPage.items.length,
        edgeRows: edgePage.items.length,
        perType: score.perType,
        entityOverall: score.entityOverall,
        relationships: score.relationships,
        unexpectedEntities: score.unexpectedEntities,
        missedEntities: score.missedEntities,
        unexpectedRelationships: score.unexpectedRelationships,
        missedRelationships: score.missedRelationships,
        spend,
        elapsedMs,
      },
      null,
      2,
    ),
  );

  return { score, summary, entityRows: entityPage.items.length, paragraphs: paragraphIds.length };
}

describe.skipIf(ANTHROPIC_KEY === '')('personal extraction eval — cloud leg (Haiku)', () => {
  it('measures entity/relationship precision + recall (no pass bar — honest numbers)', async () => {
    const llm = new AnthropicLLMProvider({ apiKey: ANTHROPIC_KEY, defaultModel: DEV_HAIKU_MODEL });
    const result = await runEval('cloud-haiku', llm, DEV_HAIKU_MODEL);

    // Structural honesty only — every paragraph accounted for exactly once.
    expect(result.summary.extracted + result.summary.skipped + result.summary.errors.length).toBe(
      result.paragraphs,
    );
    expect(result.summary.entitiesWritten).toBe(result.entityRows);
  }, 600_000);
});

describe.skipIf(!LOCAL_AVAILABLE)(`personal extraction eval — local leg (${LOCAL_MODEL})`, () => {
  it('measures the same corpus on the local model (no pass bar — honest numbers)', async () => {
    // Warm the model so cold-load time is not billed to the first paragraph.
    await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: LOCAL_MODEL,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
      signal: AbortSignal.timeout(LOCAL_CALL_TIMEOUT_MS),
    });
    const llm = new OllamaLLMProvider({
      baseUrl: OLLAMA_BASE_URL,
      defaultModel: LOCAL_MODEL,
      timeoutMs: LOCAL_CALL_TIMEOUT_MS,
    });
    const result = await runEval('local-ollama', llm, LOCAL_MODEL);

    expect(result.summary.extracted + result.summary.skipped + result.summary.errors.length).toBe(
      result.paragraphs,
    );
    expect(result.summary.entitiesWritten).toBe(result.entityRows);
  }, 3_600_000);
});
