// Cohere Rerank on AWS Bedrock — a purpose-built cross-encoder RerankProvider.
// RESIDENCY: Cohere/Amazon Rerank on Bedrock is NOT available in eu-west-2
// (London); it is eu-central-1 (Frankfurt) only, so it is RULED OUT on UK data
// residency and is NOT the preferred/UK reranker.
// It stays selectable only for non-residency contexts (and P2's MUNIN_LOCAL_MODE
// no-egress guard refuses it outright). The UK-safe reranker is the self-hosted
// open cross-encoder — HttpCrossEncoderRerankProvider (RERANK_PROVIDER=cross-encoder).
// The AWS SDK import is confined to this file + the other bedrock-*.ts providers.
// Same auth (AWS_BEARER_TOKEN_BEDROCK else the default chain) and the same
// timeout/retry/keep-alive resilience as the LLM and embedding Bedrock providers.
//
// Re-orders ONLY the candidate documents handed to it (already permission-
// filtered by the caller). It never fetches documents, so it cannot surface
// anything outside the caller's permissions.

import { Agent } from 'node:https';

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

import { ProviderConfigurationError, ProviderError } from './provider-errors';
import type {
  ProviderCallContext,
  RerankProvider,
  RerankRequest,
  RerankResponse,
  RerankResult,
} from './provider-types';
import { DEFAULT_RESILIENCE, type ResilienceOptions, invokeWithResilience } from './resilience';

const PROVIDER_ID = 'cohere-bedrock';
const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 16 });

interface CohereRerankResult {
  readonly index: number;
  readonly relevance_score: number;
}
interface CohereRerankBody {
  readonly results?: readonly CohereRerankResult[];
}

export interface BedrockCohereRerankProviderConfig {
  readonly region: string;
  readonly modelId: string; // e.g. 'cohere.rerank-v3-5:0'
  readonly client?: BedrockRuntimeClient; // injected for tests
  readonly resilience?: Partial<Omit<ResilienceOptions, 'providerId'>>;
  readonly maxDocuments?: number;
}

export class BedrockCohereRerankProvider implements RerankProvider {
  readonly id = PROVIDER_ID;
  readonly modelId: string;
  readonly maxDocuments: number;
  private readonly client: BedrockRuntimeClient;
  private readonly resilience: ResilienceOptions;

  constructor(config: BedrockCohereRerankProviderConfig) {
    if (!config.region.trim())
      throw new ProviderConfigurationError(PROVIDER_ID, 'region is required');
    if (!config.modelId.trim())
      throw new ProviderConfigurationError(PROVIDER_ID, 'modelId is required');
    this.modelId = config.modelId;
    this.maxDocuments = config.maxDocuments ?? 1000; // Cohere rerank handles large pools natively
    this.resilience = {
      providerId: PROVIDER_ID,
      timeoutMs: config.resilience?.timeoutMs ?? DEFAULT_RESILIENCE.timeoutMs,
      maxAttempts: config.resilience?.maxAttempts ?? DEFAULT_RESILIENCE.maxAttempts,
      baseDelayMs: config.resilience?.baseDelayMs ?? DEFAULT_RESILIENCE.baseDelayMs,
      ...(config.resilience?.sleep ? { sleep: config.resilience.sleep } : {}),
      ...(config.resilience?.random ? { random: config.resilience.random } : {}),
    };
    this.client =
      config.client ??
      new BedrockRuntimeClient({
        region: config.region,
        maxAttempts: 1,
        requestHandler: {
          requestTimeout: this.resilience.timeoutMs,
          connectionTimeout: 10_000,
          httpsAgent: keepAliveAgent,
        },
      });
  }

  async rerank(request: RerankRequest, _ctx: ProviderCallContext): Promise<RerankResponse> {
    const docs = request.documents.slice(0, this.maxDocuments);
    if (docs.length === 0) return { ranking: [], modelId: this.modelId };

    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(
        JSON.stringify({
          api_version: 2,
          query: request.query,
          documents: docs.map((d) => d.text),
          top_n: Math.min(request.topK, docs.length),
        }),
      ),
    });

    const response: InvokeModelCommandOutput = await invokeWithResilience(
      ({ abortSignal }) => this.client.send(command, { abortSignal }),
      this.resilience,
    );
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as CohereRerankBody;
    const results = parsed.results ?? [];

    const ranking: RerankResult[] = [];
    for (const r of results) {
      const doc = docs[r.index];
      if (!doc) continue;
      ranking.push({ id: doc.id, score: r.relevance_score });
      if (ranking.length >= request.topK) break;
    }
    if (ranking.length === 0 && results.length === 0) {
      throw new ProviderError(PROVIDER_ID, 'rerank returned no results');
    }
    return { ranking, modelId: this.modelId };
  }
}
