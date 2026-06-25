// Extractor — the orchestrator that turns a paragraph into graph rows.
//
// Process:
//   1. Upsert the extractor_versions row keyed by
//      (tenant, configurationId, schemaHash, promptHash, modelId).
//   2. Build the cacheable system + tool definition once per Configuration
//      (memoised by schemaHash).
//   3. For each paragraph:
//      a. Call Claude with tool_choice forcing the extraction tool.
//      b. Walk content blocks for tool_use; treat absence as empty extraction.
//      c. Validate the tool input against the configuration's schemas.
//      d. On failure: one repair attempt with the error list. If repair
//         fails, log to llm_calls.metadata and skip.
//      e. On success: compute verbatim-match confidence per entity, persist
//         entities + edges with full provenance.

import { computeSchemaHash } from '@muninhq/shared';
import type { Configuration } from '@muninhq/shared';

import type { GraphStore } from '../graph/graph-store';
import {
  type ActorId,
  type EntityId,
  type ExtractorVersion,
  type Paragraph,
  type ParagraphId,
  type TenantId,
  asActorId,
  internalBypass,
  newEdgeId,
  newEntityId,
} from '../graph/types';
import type {
  LLMProvider,
  ProviderCallContext,
  LLMMessage as ProviderLLMMessage,
} from '../providers';
import { computeVerbatimConfidence } from './confidence';
import { EXTRACTION_TOOL_NAME, assembleExtractionPrompt } from './prompt-assembly';
import { computePromptHash } from './prompt-hashing';
import { buildRepairMessage } from './repair-prompt';
import { type ValidationError, validateExtractionOutput } from './validation';

const ACTOR: ActorId = asActorId('system:extractor');

export interface ExtractorOptions {
  readonly graphStore: GraphStore;
  readonly llmProvider: LLMProvider;
  readonly configuration: Configuration;
  readonly modelId?: string;
  // Cache tier for the static extraction prefix. Default 'ephemeral'
  // (5min) suits batch workloads. 'extended' (1h) is opt-in for
  // sustained trickle workloads via the EXTRACTION_CACHE_TIER env var
  // (handled by the worker entry point, not here).
  readonly cacheTier?: 'ephemeral' | 'extended';
}

export interface ExtractionResult {
  readonly paragraphId: ParagraphId;
  readonly outcome:
    | 'extracted'
    | 'no-tool-call'
    | 'validation-failed'
    | 'error'
    | 'skipped-existing';
  readonly entitiesWritten: number;
  readonly edgesWritten: number;
  readonly repairUsed: boolean;
  // F63: how many top-level stringified array arguments the validation shim
  // parse-substituted across this paragraph's attempts (first + repair).
  readonly stringifiedArraysParsed: number;
  readonly errorMessage?: string;
}

export class Extractor {
  private readonly modelId: string;
  private readonly schemaHash: string;
  private readonly promptHash: string;
  private extractorVersion: ExtractorVersion | undefined;

  constructor(private readonly opts: ExtractorOptions) {
    this.modelId = opts.modelId ?? opts.llmProvider.defaultModel;
    this.schemaHash = computeSchemaHash(opts.configuration);
    this.promptHash = computePromptHash({
      configurationId: opts.configuration.id,
      configurationVersion: opts.configuration.version,
      schemaHash: this.schemaHash,
      modelId: this.modelId,
    });
  }

  // Lazy: the extractor_versions row is upserted on first call. Subsequent
  // calls reuse the cached value.
  private async ensureExtractorVersion(tenantId: TenantId): Promise<ExtractorVersion> {
    if (this.extractorVersion && this.extractorVersion.tenantId === tenantId) {
      return this.extractorVersion;
    }
    const writeCtx = { tenantId, actor: ACTOR };
    this.extractorVersion = await this.opts.graphStore.upsertExtractorVersion(writeCtx, {
      configurationId: this.opts.configuration.id,
      configurationVersion: this.opts.configuration.version,
      schemaHash: this.schemaHash,
      promptHash: this.promptHash,
      modelId: this.modelId,
    });
    return this.extractorVersion;
  }

  async extractParagraph(tenantId: TenantId, paragraphId: ParagraphId): Promise<ExtractionResult> {
    const extractorVersion = await this.ensureExtractorVersion(tenantId);

    // Fetch the paragraph + parent document under bypass — this is a system
    // operation.
    const bypassCtx = {
      kind: 'bypass' as const,
      tenantId,
      bypass: internalBypass(
        'extractor.extractParagraph',
        'system extraction requires read access independent of caller tags',
      ),
      actor: ACTOR,
    };
    const paragraph = await this.opts.graphStore.getParagraph(bypassCtx, paragraphId);
    if (!paragraph) {
      return baseResult(paragraphId, 'error', false, `paragraph ${paragraphId} not found`);
    }

    // Retry-idempotency: a graphile-worker job carries a batch of paragraphs
    // processed sequentially, and a throw on a later paragraph retries the
    // WHOLE job. Without this guard, paragraphs already committed earlier in
    // the batch would be extracted again on retry, producing duplicate
    // entities (v1 has no dedup, decisions 14). If this paragraph already has a
    // live entity written by THIS extractor version (same schema+prompt+model),
    // the work is done — skip it so a retry is a no-op.
    //
    // Note: a paragraph that legitimately produced zero entities is not
    // detectable here and will be re-attempted on retry; that re-attempt is an
    // empty extraction (no duplicate, just a redundant call), which is
    // acceptable. The bug this closes is duplicate *entities*, which only arise
    // when a paragraph produced ≥1 entity.
    const existing = await this.opts.graphStore.findEntitiesByParagraphIds(bypassCtx, [
      paragraphId,
    ]);
    const alreadyExtracted = existing.some(
      (e) =>
        e.provenance.kind === 'document_extract' &&
        e.provenance.extractorVersionId === extractorVersion.id,
    );
    if (alreadyExtracted) {
      return baseResult(paragraphId, 'skipped-existing', false);
    }

    const callCtx: ProviderCallContext = {
      tenantId,
      purpose: 'extraction',
      graphStore: this.opts.graphStore,
      extractorVersionId: extractorVersion.id,
      documentId: paragraph.documentId,
    };

    // Build (or reuse — same configuration per Extractor instance) the prompt.
    const assembled = assembleExtractionPrompt(this.opts.configuration);

    // First attempt
    const first = await this.callLlm(assembled, paragraph, callCtx, []);
    if (first.kind === 'error') {
      return baseResult(paragraphId, 'error', false, first.message);
    }
    if (first.toolInput === undefined) {
      // Claude declined to call the tool. Treat as a clean empty extraction.
      return baseResult(paragraphId, 'no-tool-call', false);
    }

    const firstValidation = validateExtractionOutput(first.toolInput, this.opts.configuration);
    if (firstValidation.ok) {
      const written = await this.persist(
        firstValidation.value,
        paragraph,
        extractorVersion,
        tenantId,
      );
      return {
        paragraphId,
        outcome: 'extracted',
        entitiesWritten: written.entities,
        edgesWritten: written.edges,
        repairUsed: false,
        stringifiedArraysParsed: firstValidation.stringifiedArraysParsed,
      };
    }

    // Repair attempt
    const repair = await this.callLlm(assembled, paragraph, callCtx, firstValidation.errors, {
      previousToolInput: first.toolInput,
    });
    if (repair.kind === 'error') {
      return baseResult(
        paragraphId,
        'error',
        true,
        repair.message,
        firstValidation.stringifiedArraysParsed,
      );
    }
    if (repair.toolInput === undefined) {
      return baseResult(
        paragraphId,
        'validation-failed',
        true,
        'repair did not call the tool',
        firstValidation.stringifiedArraysParsed,
      );
    }
    const repairValidation = validateExtractionOutput(repair.toolInput, this.opts.configuration);
    const totalParsed =
      firstValidation.stringifiedArraysParsed + repairValidation.stringifiedArraysParsed;
    if (!repairValidation.ok) {
      return baseResult(
        paragraphId,
        'validation-failed',
        true,
        summariseErrors(repairValidation.errors),
        totalParsed,
      );
    }
    const written = await this.persist(
      repairValidation.value,
      paragraph,
      extractorVersion,
      tenantId,
    );
    return {
      paragraphId,
      outcome: 'extracted',
      entitiesWritten: written.entities,
      edgesWritten: written.edges,
      repairUsed: true,
      stringifiedArraysParsed: totalParsed,
    };
  }

  private async callLlm(
    assembled: ReturnType<typeof assembleExtractionPrompt>,
    paragraph: Paragraph,
    callCtx: ProviderCallContext,
    repairErrors: readonly ValidationError[],
    repairCtx?: { previousToolInput: unknown },
  ): Promise<
    | { kind: 'ok'; toolInput: Record<string, unknown> | undefined }
    | { kind: 'error'; message: string }
  > {
    const userParts: string[] = [];
    userParts.push(`Paragraph index: ${paragraph.paragraphIndex}`);
    if (paragraph.page !== null) userParts.push(`Page: ${paragraph.page}`);
    const headingPath = paragraph.structure.headingPath;
    if (headingPath && headingPath.length > 0) {
      userParts.push(`Section: ${headingPath.join(' > ')}`);
    }
    userParts.push('');
    userParts.push('Text:');
    userParts.push('"""');
    userParts.push(paragraph.text);
    userParts.push('"""');

    const messages: ProviderLLMMessage[] = [{ role: 'user', content: userParts.join('\n') }];
    if (repairCtx) {
      messages.push({
        role: 'assistant',
        content: `(previous tool call returned: ${JSON.stringify(repairCtx.previousToolInput)})`,
      });
      messages.push({
        role: 'user',
        content: buildRepairMessage(repairCtx.previousToolInput, repairErrors),
      });
    }

    try {
      const response = await this.opts.llmProvider.complete(
        {
          // Authoritative for the call, not just provenance: when no modelId
          // was supplied this is the provider's own defaultModel (line 82), so
          // omitting vs. passing it is identical — but supplying EXTRACTION_MODEL
          // at the entry points must actually select that model for extraction,
          // independently of the answer model (which the query pipeline sets via
          // request.model from ANSWER_MODEL).
          model: this.modelId,
          system: assembled.system,
          messages,
          cacheableSystemPrefix: true,
          cacheTier: this.opts.cacheTier ?? 'ephemeral',
          tools: [assembled.tool],
          toolChoice: { type: 'tool', name: assembled.toolName },
          maxOutputTokens: 4096,
        },
        callCtx,
      );

      // Find a tool_use block. Walk all blocks (Claude may emit text before
      // the tool call); pick the matching tool. If none, return undefined.
      const match = response.toolCalls.find((c) => c.name === EXTRACTION_TOOL_NAME);
      if (!match) return { kind: 'ok', toolInput: undefined };
      return { kind: 'ok', toolInput: match.input };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async persist(
    output: {
      entities: ReadonlyArray<{ type: string; properties: Readonly<Record<string, unknown>> }>;
      relationships?: ReadonlyArray<{
        type: string;
        fromIndex: number;
        toIndex: number;
        properties?: Readonly<Record<string, unknown>>;
      }>;
    },
    paragraph: Paragraph,
    extractorVersion: ExtractorVersion,
    tenantId: TenantId,
  ): Promise<{ entities: number; edges: number }> {
    const writeCtx = { tenantId, actor: ACTOR };
    const entityIds: EntityId[] = [];
    let entities = 0;
    let edges = 0;

    await this.opts.graphStore.withTransaction(writeCtx, async (tx) => {
      for (const entity of output.entities) {
        const id = newEntityId();
        entityIds.push(id);
        const confidence = computeVerbatimConfidence(entity.properties, paragraph.text);
        await tx.insertEntity(writeCtx, {
          id,
          type: entity.type,
          properties: entity.properties,
          accessTags: paragraph.accessTags,
          provenance: {
            kind: 'document_extract',
            documentId: paragraph.documentId,
            paragraphId: paragraph.id,
            extractorVersionId: extractorVersion.id,
            confidence,
          },
        });
        entities++;
      }
      for (const rel of output.relationships ?? []) {
        const fromId = entityIds[rel.fromIndex];
        const toId = entityIds[rel.toIndex];
        if (!fromId || !toId) continue;
        await tx.insertEdge(writeCtx, {
          id: newEdgeId(),
          type: rel.type,
          fromEntityId: fromId,
          toEntityId: toId,
          properties: rel.properties ?? {},
          accessTags: paragraph.accessTags,
          provenance: {
            kind: 'document_extract',
            documentId: paragraph.documentId,
            paragraphId: paragraph.id,
            extractorVersionId: extractorVersion.id,
            confidence: null,
          },
        });
        edges++;
      }
    });

    return { entities, edges };
  }
}

function baseResult(
  paragraphId: ParagraphId,
  outcome: ExtractionResult['outcome'],
  repairUsed: boolean,
  errorMessage?: string,
  stringifiedArraysParsed = 0,
): ExtractionResult {
  return {
    paragraphId,
    outcome,
    entitiesWritten: 0,
    edgesWritten: 0,
    repairUsed,
    stringifiedArraysParsed,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function summariseErrors(errors: readonly ValidationError[]): string {
  const top = errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`);
  const tail = errors.length > 3 ? `; +${errors.length - 3} more` : '';
  return top.join('; ') + tail;
}
