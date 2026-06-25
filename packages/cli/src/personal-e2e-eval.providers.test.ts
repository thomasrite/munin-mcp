// End-to-end acceptance harness for @muninhq/config-personal — the WHOLE pipeline,
// scored, in one run, as a MULTI-MODEL bake-off so a single comparative scorecard
// shows, at a glance, which model gives the best quality (extraction recall, Q&A
// answer-accuracy, citation-accuracy, no-fabrication, generation grounding) and
// the speed trade. SYNTHETIC data only — it extends the package's golden corpus;
// it never touches real data and it changes nothing in the engine (it composes
// the frozen public API: ingest → extract → QueryPipeline → generateDocument).
//
// Three scored stages per leg, each scored by the config layer's pure scorers:
//   1. EXTRACTION  — entity/relationship precision + recall (scoreExtraction).
//   2. Q&A         — answer-accuracy + citation-match (the RIGHT paragraph) +
//                    no-fabrication (a corpus-absent question must decline).
//   3. GENERATION  — Person-dossier structure-match + per-claim grounding (every
//                    surviving citation re-grounds; an ungrounded survivor fails).
//
// The legs:
//   • CLOUD SWEEP — a configurable LIST of legs, each {label, provider, model}
//     (provider ∈ anthropic | openai). Default sweep (each model id overridable
//     via env): claude-sonnet-4-6, claude-haiku-4-5-20251001 (Anthropic) and a
//     strong + a cheap OpenAI model. Each leg .skipIf its provider key is absent.
//     CRITICAL for a fair comparison: ALL cloud legs share ONE embedder
//     (OpenAI text-embedding-3-small@1024), so the only variable between cloud
//     legs is the LLM.
//   • LOCAL (the fully-local reference) — qwen2.5:7b + bge-m3 on a reachable
//     Ollama daemon; .skipIf either is absent. Its embedder (bge-m3) differs by
//     necessity (it is the offline reference), noted on the scorecard.
//
// Per-leg wall-clock is recorded so the scorecard shows speed alongside quality.
//
// Store: PGlite in a temp dir (real Postgres + pgvector in WASM) — same store
// class, same migrations, same permission path as hosted; no Docker. Reads use a
// REGULAR context under the owner role's tags, so the run also proves the
// role-tag ↔ ingest-tag alignment end-to-end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import personalConfiguration, { personDossier } from '@muninhq/config-personal';
import {
  type ExtractedEntityLike,
  type ExtractedRelationshipLike,
  type GenerationObservation,
  type GenerationScore,
  type PersonalEvalScore,
  type QaQuestionScore,
  type ResolvedCitation,
  aggregateGenerationScores,
  aggregateQaScores,
  paragraphsOf,
  personalEvalCorpus,
  personalGenerationSubjects,
  personalQuestionMatrix,
  scoreExtraction,
  scoreGeneration,
  scoreQaAnswer,
} from '@muninhq/config-personal/eval';
import {
  AnthropicLLMProvider,
  type DocumentId,
  type EmbeddingProvider,
  type Entity,
  type EntityId,
  type GenerationSource,
  type LLMProvider,
  OllamaEmbeddingProvider,
  OllamaLLMProvider,
  OpenAIEmbeddingProvider,
  OpenAILLMProvider,
  type Paragraph,
  type ParagraphId,
  QueryPipeline,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
  gatherByIdentity,
  generateDocument,
  newParagraphId,
  verifyQuoteGrounding,
} from '@muninhq/engine';
import { tenants } from '@muninhq/engine/db/schema';
import { type GraphStoreHandle, loadGraphStore } from '@muninhq/engine/graph-store';
import { InlineEmbedRunner, InlineExtractRunner } from '@muninhq/engine/jobs';
import { afterAll, describe, expect, it } from 'vitest';

import { queryOptionsFromConfig } from './query-defaults';

const ACTOR = asActorId('personal-e2e-eval');
// The tag local:init's printed ingest command writes — also the owner role's
// base tag (the alignment the cross-check pins).
const TAGS = ['personal'];
const SCHEMA_EMBEDDING_DIMENSIONS = 1024;

// The scorecard is written to a FILE (and stdout) — vitest intercepts console
// output, so a passing run would otherwise swallow the deliverable.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCORECARD_PATH = path.join(repoRoot, 'output', 'personal-e2e-scorecard.md');
function emit(text: string): void {
  process.stdout.write(`${text}\n`);
}
function writeScorecardFile(text: string): void {
  fs.mkdirSync(path.dirname(SCORECARD_PATH), { recursive: true });
  fs.writeFileSync(SCORECARD_PATH, text, 'utf8');
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim() ?? '';

// The cloud bake-off: a list of {label, provider, model} legs. Each model id is
// env-overridable; the whole list can be replaced with MUNIN_E2E_SWEEP (a JSON
// array of {label, provider, model}). Each leg skips if its provider key is
// absent. The default sweep pairs the two Anthropic tiers with a strong + a
// cheap OpenAI tier.
type CloudProvider = 'anthropic' | 'openai';
interface CloudLeg {
  readonly label: string;
  readonly provider: CloudProvider;
  readonly model: string;
}
const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
const DEFAULT_CLOUD_SWEEP: CloudLeg[] = [
  {
    label: 'sonnet-4.6',
    provider: 'anthropic',
    model: env('SWEEP_ANTHROPIC_STRONG') ?? 'claude-sonnet-4-6',
  },
  {
    label: 'haiku-4.5',
    provider: 'anthropic',
    model: env('SWEEP_ANTHROPIC_FAST') ?? 'claude-haiku-4-5-20251001',
  },
  { label: 'gpt-4.1', provider: 'openai', model: env('SWEEP_OPENAI_STRONG') ?? 'gpt-4.1' },
  { label: 'gpt-4.1-mini', provider: 'openai', model: env('SWEEP_OPENAI_CHEAP') ?? 'gpt-4.1-mini' },
];
function parseSweepOverride(): CloudLeg[] | undefined {
  const raw = env('MUNIN_E2E_SWEEP');
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as CloudLeg[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('MUNIN_E2E_SWEEP must be a non-empty JSON array of {label,provider,model}');
  }
  return parsed;
}
const CLOUD_SWEEP: CloudLeg[] = parseSweepOverride() ?? DEFAULT_CLOUD_SWEEP;

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(
  /\/$/,
  '',
);
const LOCAL_MODEL = process.env.MUNIN_PERSONAL_EVAL_LOCAL_MODEL ?? 'qwen2.5:7b';
const LOCAL_EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'bge-m3';
const LOCAL_CALL_TIMEOUT_MS = Number(process.env.MUNIN_OLLAMA_EXTRACT_TIMEOUT_MS ?? '300000');

async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    // Tag-tolerant: Ollama stores `bge-m3` as `bge-m3:latest`, so match on the
    // base name (before the `:tag`) as well as the exact string.
    const base = (n: string): string => n.split(':')[0] ?? n;
    return (body.models ?? []).some(
      (m) => m.name === model || (m.name && base(m.name) === base(model)),
    );
  } catch {
    return false;
  }
}

const QWEN_AVAILABLE = await ollamaHasModel(LOCAL_MODEL);
const BGE_AVAILABLE = await ollamaHasModel(LOCAL_EMBED_MODEL);
// Cloud legs need a real embedder: OpenAI by key, else local bge-m3.
const CLOUD_EMBED_AVAILABLE = OPENAI_KEY !== '' || BGE_AVAILABLE;
const LOCAL_AVAILABLE = QWEN_AVAILABLE && BGE_AVAILABLE;

const tempDirs: string[] = [];
const handles: GraphStoreHandle[] = [];

afterAll(async () => {
  for (const handle of handles) await handle.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  printComparativeScorecard();
});

// Minimal structural view over the PGlite/postgres-js Drizzle union (the
// sanctioned local-init pattern — the chained query shape is identical).
interface EvalDb {
  insert(table: typeof tenants): { values(row: { id: string; name: string }): Promise<unknown> };
}

function bgeEmbedding(): EmbeddingProvider {
  return new OllamaEmbeddingProvider({
    baseUrl: OLLAMA_BASE_URL,
    modelId: LOCAL_EMBED_MODEL,
    dimensions: SCHEMA_EMBEDDING_DIMENSIONS,
    timeoutMs: LOCAL_CALL_TIMEOUT_MS,
  });
}

// The ONE embedder shared by every cloud sweep leg so the LLM is the only
// variable: OpenAI text-embedding-3-small@1024 when the key is present, else the
// local bge-m3 fallback (both 1024-dim). A fresh instance per leg (each leg owns
// its own store/tenant); identical model = fair comparison.
function cloudEmbedder(): EmbeddingProvider {
  return OPENAI_KEY !== ''
    ? new OpenAIEmbeddingProvider({
        apiKey: OPENAI_KEY,
        modelId: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
        dimensions: SCHEMA_EMBEDDING_DIMENSIONS,
      })
    : bgeEmbedding();
}

function cloudLlm(leg: CloudLeg): LLMProvider {
  return leg.provider === 'anthropic'
    ? new AnthropicLLMProvider({ apiKey: ANTHROPIC_KEY, defaultModel: leg.model })
    : new OpenAILLMProvider({ apiKey: OPENAI_KEY, defaultModel: leg.model });
}

// A cloud leg can run when its provider key AND a real embedder are present.
function cloudLegAvailable(leg: CloudLeg): boolean {
  const keyPresent = leg.provider === 'anthropic' ? ANTHROPIC_KEY !== '' : OPENAI_KEY !== '';
  return keyPresent && CLOUD_EMBED_AVAILABLE;
}

// ---------------------------------------------------------------------------
// One leg's scorecard (accumulated across the run, printed comparatively).
// ---------------------------------------------------------------------------
interface LegScorecard {
  readonly label: string;
  readonly llmModel: string;
  readonly embeddingModel: string;
  readonly extraction: PersonalEvalScore;
  readonly extractionRepairs: number;
  readonly qa: ReturnType<typeof aggregateQaScores>;
  readonly generation: ReturnType<typeof aggregateGenerationScores>;
  readonly elapsedMs: number;
}
const scorecards: LegScorecard[] = [];

interface LegConfig {
  readonly label: string;
  readonly llm: LLMProvider;
  readonly extractionModel: string;
  readonly embedding: EmbeddingProvider;
  readonly answerModel: string;
}

const norm = (s: unknown): string =>
  typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '';

async function runFullPipeline(cfg: LegConfig): Promise<LegScorecard> {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-personal-e2e-'));
  tempDirs.push(dir);
  const handle = await loadGraphStore({
    GRAPH_STORE: 'local',
    PGLITE_DATA_DIR: dir,
  } as NodeJS.ProcessEnv);
  handles.push(handle);

  const tenantId: TenantId = asTenantId(crypto.randomUUID());
  const db = handle.db as unknown as EvalDb;
  await db.insert(tenants).values({ id: tenantId, name: `personal-e2e-${cfg.label}` });

  // --- seed the corpus exactly as ingestion would store it, recording the maps
  //     the Q&A + generation legs need (paragraph location, per-doc paragraphs).
  const wctx: WriteContext = { tenantId, actor: ACTOR };
  const allParagraphIds: ParagraphId[] = [];
  const paraLoc = new Map<string, ResolvedCitation>(); // paragraphId -> {docFile, paragraphIndex}
  const docFileById = new Map<string, string>(); // documentId -> docFile
  const parasByDocId = new Map<string, ParagraphId[]>(); // documentId -> paragraphIds
  for (const doc of personalEvalCorpus) {
    const inserted = await handle.store.insertDocument(wctx, {
      title: doc.file,
      blobStorageUri: `mem://personal-e2e/${doc.file}`,
      accessTags: TAGS,
    });
    docFileById.set(String(inserted.id), doc.file);
    const ids: ParagraphId[] = [];
    await handle.store.insertParagraphsBulk(
      wctx,
      paragraphsOf(doc).map((text, i) => {
        const id = newParagraphId();
        allParagraphIds.push(id);
        ids.push(id);
        paraLoc.set(String(id), { docFile: doc.file, paragraphIndex: i });
        return { id, documentId: inserted.id, paragraphIndex: i, text, accessTags: TAGS };
      }),
    );
    parasByDocId.set(String(inserted.id), ids);
  }

  // --- embeddings (needed by the Q&A vector path) ---
  // Embed BEFORE extraction. The two are independent (embeddings need only the
  // seeded paragraphs; extraction needs only the same paragraphs), and on the
  // local leg the embedder (bge-m3) and the extractor (qwen2.5:7b) share one
  // Ollama daemon — running the bulk embed first, while the daemon is fresh,
  // avoids the model-eviction/contention window that a 40-minute extraction phase
  // opens before it. Pure ordering; it changes no measured number.
  const embedRunner = new InlineEmbedRunner({
    graphStore: handle.store,
    embeddingProvider: cfg.embedding,
  });
  await embedRunner.enqueueAll([
    { tenantId, paragraphIds: allParagraphIds, modelId: cfg.embedding.modelId },
  ]);

  // --- LEG 1: extraction (scored) ---
  const extractRunner = new InlineExtractRunner({
    graphStore: handle.store,
    llmProvider: cfg.llm,
    configuration: personalConfiguration,
    modelId: cfg.extractionModel,
  });
  const extractSummary = await extractRunner.run([{ tenantId, paragraphIds: allParagraphIds }]);

  // Read back the extracted graph under the owner role's tags (a REGULAR
  // permissioned read — proves the printed ingest tag is readable by the role).
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
  const extraction = scoreExtraction({
    entities: extractedEntities,
    relationships: extractedRelationships,
  });

  // --- LEG 2: Q&A with citation-match + no-fabrication ---
  const pipeline = new QueryPipeline({
    graphStore: handle.store,
    llmProvider: cfg.llm,
    embeddingProvider: cfg.embedding,
    model: cfg.answerModel,
    // The eval scores answers + grounding, not the P3b "sources disagree" pass;
    // disabling it keeps both legs uniform (the local model has no Haiku to call).
    contradictionDetection: false,
    ...queryOptionsFromConfig(personalConfiguration),
  });
  const qaScores: QaQuestionScore[] = [];
  for (const q of personalQuestionMatrix) {
    const res = await pipeline.answer({
      tenantId,
      accessTags: TAGS,
      question: q.question,
      actor: ACTOR,
    });
    const citations: ResolvedCitation[] = res.citations
      .map((c) => paraLoc.get(String(c.paragraphId)))
      .filter((loc): loc is ResolvedCitation => loc !== undefined);
    qaScores.push(scoreQaAnswer(q, { status: res.status, answerText: res.answer, citations }));
  }
  const qa = aggregateQaScores(qaScores);

  // --- LEG 3: Person-dossier generation (structure + grounding) ---
  const autoSections = personDossier.sections
    .filter((s) => s.fill.kind === 'auto-from-gather')
    .map((s) => ({
      heading: s.heading,
      instruction: s.fill.kind === 'auto-from-gather' ? s.fill.instruction : '',
    }));
  const expectedHeadings = autoSections.map((s) => s.heading);
  const persons = entityPage.items.filter((e) => e.type === 'Person');

  const genScores: GenerationScore[] = [];
  for (const subject of personalGenerationSubjects) {
    const obs = await generateDossier({
      subject,
      persons,
      autoSections,
      expectedHeadings,
      parasByDocId,
      docFileById,
      rctx,
      handle,
      llm: cfg.llm,
      model: cfg.answerModel,
      tenantId,
    });
    genScores.push(scoreGeneration(obs));
  }
  const generation = aggregateGenerationScores(genScores);

  const card: LegScorecard = {
    label: cfg.label,
    llmModel: cfg.answerModel,
    embeddingModel: cfg.embedding.modelId,
    extraction,
    extractionRepairs: extractSummary.repairsUsed,
    qa,
    generation,
    elapsedMs: Date.now() - started,
  };
  scorecards.push(card);
  printLeg(card, extractSummary);
  return card;
}

// Gather a subject's records, generate the dossier's auto sections (single LLM
// call per section — scopeSourcesToSections:false keeps it provider-uniform; the
// Haiku source-routing pre-step would break the local Ollama leg), then build the
// scorer's observation by re-grounding every surviving citation independently.
async function generateDossier(p: {
  readonly subject: string;
  readonly persons: readonly Entity[];
  readonly autoSections: readonly { heading: string; instruction: string }[];
  readonly expectedHeadings: readonly string[];
  readonly parasByDocId: ReadonlyMap<string, ParagraphId[]>;
  readonly docFileById: ReadonlyMap<string, string>;
  readonly rctx: ReadContext;
  readonly handle: GraphStoreHandle;
  readonly llm: LLMProvider;
  readonly model: string;
  readonly tenantId: TenantId;
}): Promise<GenerationObservation> {
  const empty: GenerationObservation = {
    subject: p.subject,
    status: 'no_evidence',
    expectedHeadings: p.expectedHeadings,
    sections: [],
    regroundVerdicts: [],
    droppedClaims: 0,
    recordCount: 0,
  };

  const want = norm(p.subject);
  const cluster = p.persons.filter((e) => {
    const name = norm(e.properties.fullName);
    return name !== '' && (name === want || name.includes(want) || want.includes(name));
  });
  if (cluster.length === 0) return empty; // the model never extracted this person — a measured gap

  const gathered = await gatherByIdentity(p.handle.store, p.rctx, {
    entityType: 'Person',
    keyProperty: 'fullName',
    keyValue: p.subject,
    clusterMemberIds: cluster.map((e) => e.id as EntityId),
  });
  const sourceParaIds = gathered.documentIds.flatMap(
    (d: DocumentId) => p.parasByDocId.get(String(d)) ?? [],
  );
  if (sourceParaIds.length === 0) return empty;
  const paras = await p.handle.store.getParagraphsByIds(p.rctx, sourceParaIds);
  const paraText = new Map<string, string>(paras.map((pa: Paragraph) => [String(pa.id), pa.text]));
  const sources: GenerationSource[] = paras.map((pa: Paragraph, i: number) => {
    const title = p.docFileById.get(String(pa.documentId));
    return { sourceId: `P${i + 1}`, paragraph: pa, ...(title ? { documentTitle: title } : {}) };
  });

  const doc = await generateDocument(
    p.llm,
    { tenantId: p.tenantId, purpose: 'generation', graphStore: p.handle.store },
    {
      subject: p.subject,
      sections: [...p.autoSections],
      sources,
      completeness: {
        mayHaveUnlinkedRecords: gathered.mayHaveUnlinkedRecords,
        recordCount: sources.length,
      },
      model: p.model,
      // Uniform single-call path across legs (see note above).
      scopeSourcesToSections: false,
    },
  );

  // Re-ground EVERY surviving citation independently of the engine's own resolve.
  const regroundVerdicts = doc.citations.map((c) => {
    const text = paraText.get(String(c.paragraphId));
    return text ? verifyQuoteGrounding(c.quote, text) : false;
  });

  return {
    subject: p.subject,
    status: doc.status,
    expectedHeadings: p.expectedHeadings,
    sections: doc.sections.map((s) => ({
      heading: s.heading,
      claimCount: s.claims.length,
      gap: s.gap,
    })),
    regroundVerdicts,
    droppedClaims: doc.droppedClaims,
    recordCount: sources.length,
  };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------
function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`;
}

function printLeg(c: LegScorecard, summary: { extracted: number; skipped: number }): void {
  const e = c.extraction.entityOverall;
  const r = c.extraction.relationships;
  emit(
    `\n[${c.label}] LLM=${c.llmModel} embed=${c.embeddingModel} (${(c.elapsedMs / 1000).toFixed(0)}s)\n` +
      `  extraction: entities P ${pct(e.matched, e.extractedDistinct)} / R ${pct(e.matched, e.expected)} · ` +
      `relationships P ${pct(r.matched, r.extractedDistinct)} / R ${pct(r.matched, r.expected)} ` +
      `(${summary.extracted} extracted, ${summary.skipped} skipped, ${c.extractionRepairs} repairs)\n` +
      `  Q&A: answer-acc ${pct(c.qa.answerAccurate, c.qa.answerable)} · ` +
      `citation-acc ${pct(c.qa.citationAccurate, c.qa.withSource)} · ` +
      `no-fabrication ${pct(c.qa.noFabrication, c.qa.negatives)}\n` +
      `  generation: structure ${pct(c.generation.structurePreserved, c.generation.generated)} · ` +
      `grounding ${c.generation.groundingPass ? 'PASS' : 'FAIL'} ` +
      `(${c.generation.totalRegrounded}/${c.generation.totalSurviving} regrounded, ${c.generation.totalDropped} dropped, ` +
      `${c.generation.generated}/${c.generation.subjects} subjects drafted)`,
  );
  // Persist after each leg so partial results survive a later flake.
  writeScorecardFile(renderScorecard());
}

function renderScorecard(): string {
  if (scorecards.length === 0) {
    return '# personal e2e scorecard\n\nNO LEGS RAN (no provider available).\n';
  }
  const L: string[] = [];
  L.push('# Personal e2e acceptance scorecard (synthetic data)');
  L.push('');
  L.push(
    `Corpus: ${personalEvalCorpus.length} docs · Q&A: ${personalQuestionMatrix.length} questions · ` +
      `generation subjects: ${personalGenerationSubjects.length}`,
  );
  for (const c of scorecards) {
    L.push(
      `· **${c.label}** — LLM ${c.llmModel}, embed ${c.embeddingModel}, ${(c.elapsedMs / 1000).toFixed(0)}s`,
    );
  }
  L.push('');
  L.push(`| stage / metric | ${scorecards.map((c) => c.label).join(' | ')} |`);
  L.push(`|---|${scorecards.map(() => '---').join('|')}|`);
  const row = (label: string, fn: (c: LegScorecard) => string): void => {
    L.push(`| ${label} | ${scorecards.map((c) => fn(c)).join(' | ')} |`);
  };
  row('extraction entity precision', (c) =>
    pct(c.extraction.entityOverall.matched, c.extraction.entityOverall.extractedDistinct),
  );
  row('extraction entity recall', (c) =>
    pct(c.extraction.entityOverall.matched, c.extraction.entityOverall.expected),
  );
  row('extraction rel precision', (c) =>
    pct(c.extraction.relationships.matched, c.extraction.relationships.extractedDistinct),
  );
  row('extraction rel recall', (c) =>
    pct(c.extraction.relationships.matched, c.extraction.relationships.expected),
  );
  row(
    'Q&A answer-accuracy',
    (c) =>
      `${pct(c.qa.answerAccurate, c.qa.answerable)} (${c.qa.answerAccurate}/${c.qa.answerable})`,
  );
  row(
    'Q&A citation-accuracy',
    (c) =>
      `${pct(c.qa.citationAccurate, c.qa.withSource)} (${c.qa.citationAccurate}/${c.qa.withSource})`,
  );
  row(
    'Q&A no-fabrication',
    (c) => `${pct(c.qa.noFabrication, c.qa.negatives)} (${c.qa.noFabrication}/${c.qa.negatives})`,
  );
  row('generation structure-match', (c) =>
    pct(c.generation.structurePreserved, c.generation.generated),
  );
  row(
    'generation grounding',
    (c) =>
      `${c.generation.groundingPass ? 'PASS' : 'FAIL'} (${c.generation.totalRegrounded}/${c.generation.totalSurviving} regrounded, ${c.generation.totalDropped} dropped)`,
  );
  row('generation subjects drafted', (c) => `${c.generation.generated}/${c.generation.subjects}`);
  L.push('');
  L.push(
    'Read: a multi-model bake-off — higher extraction recall + Q&A/citation accuracy is better; ' +
      'no-fabrication and generation grounding are model-independent trust bars that must hold for every leg. ' +
      'Cloud sweep legs share ONE embedder (text-embedding-3-small) so the LLM is the only variable; ' +
      'the qwen leg is the fully-local reference (bge-m3 embedder).',
  );
  L.push('');
  return L.join('\n');
}

function printComparativeScorecard(): void {
  const out = renderScorecard();
  emit(`\n${out}`);
  writeScorecardFile(out);
  if (scorecards.length > 0) emit(`Scorecard written to ${SCORECARD_PATH}`);
}

// ---------------------------------------------------------------------------
// The provider legs — each skips cleanly when its provider is absent. The cloud
// sweep runs one leg per configured {label, provider, model}; the local leg is
// the fully-local reference. All accumulate into ONE comparative scorecard.
// ---------------------------------------------------------------------------
for (const leg of CLOUD_SWEEP) {
  describe.skipIf(!cloudLegAvailable(leg))(
    `personal e2e — CLOUD sweep: ${leg.label} (${leg.provider}/${leg.model})`,
    () => {
      it('runs ingest → extract → ask → generate, scored', async () => {
        const card = await runFullPipeline({
          label: leg.label,
          llm: cloudLlm(leg),
          extractionModel: leg.model,
          embedding: cloudEmbedder(),
          answerModel: leg.model,
        });

        // Honest, non-gameable structural assertions only (the deliverable is the
        // scorecard, not a pass bar): every question and subject is accounted for,
        // and the hard fail-closed bar holds — no ungrounded surviving claim.
        expect(card.qa.total).toBe(personalQuestionMatrix.length);
        expect(card.generation.subjects).toBe(personalGenerationSubjects.length);
        expect(card.generation.totalUngrounded).toBe(0);
      }, 1_800_000);
    },
  );
}

describe.skipIf(!LOCAL_AVAILABLE)(
  `personal e2e — LOCAL leg (${LOCAL_MODEL} + ${LOCAL_EMBED_MODEL})`,
  () => {
    it('runs the same pipeline locally to measure the gap', async () => {
      // Warm the chat model so cold-load time is not billed to the first call.
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
      const card = await runFullPipeline({
        label: 'qwen2.5:7b',
        llm,
        extractionModel: LOCAL_MODEL,
        embedding: bgeEmbedding(),
        answerModel: LOCAL_MODEL,
      });

      // Same structural honesty; the fail-closed grounding bar must hold for the
      // local model too — a weak model may GAP sections, but it must never emit an
      // ungrounded surviving claim.
      expect(card.qa.total).toBe(personalQuestionMatrix.length);
      expect(card.generation.subjects).toBe(personalGenerationSubjects.length);
      expect(card.generation.totalUngrounded).toBe(0);
    }, 3_600_000);
  },
);
