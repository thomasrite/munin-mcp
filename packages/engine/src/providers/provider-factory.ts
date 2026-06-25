// Env-driven provider factory.
//
// The factory is the only place that touches process.env for provider
// SELECTION + CONSTRUCTION (which impl, which keys/region/models). Everywhere
// else, providers are passed in explicitly (constructor injection / test
// parameters). The query layer separately reads ANSWER_MODEL / GENERATION_MODEL
// for its per-call model DEFAULTS (a model id is infrastructure, overridable per
// request) — that is calling-side model choice, not provider configuration.

import { AnthropicLLMProvider } from './anthropic-llm-provider';
import { BedrockCohereRerankProvider } from './bedrock-cohere-rerank-provider';
import { BedrockLLMProvider } from './bedrock-llm-provider';
import { BedrockTitanEmbeddingProvider } from './bedrock-titan-embedding-provider';
import { DEV_HAIKU_MODEL, withForcedModel } from './dev-model-override';
import { HttpCrossEncoderRerankProvider } from './http-cross-encoder-rerank-provider';
import { LlmJudgeRerankProvider } from './llm-judge-rerank-provider';
import { installLocalModeEgressGuard, isLoopbackUrl } from './local-egress-guard';
import { OllamaEmbeddingProvider } from './ollama-embedding-provider';
import { OllamaLLMProvider } from './ollama-llm-provider';
import { OpenAIEmbeddingProvider } from './openai-embedding-provider';
import { OpenAILLMProvider } from './openai-llm-provider';
import { ProviderConfigurationError } from './provider-errors';
import type {
  EmbeddingProvider,
  LLMProvider,
  ProviderBundle,
  RerankProvider,
} from './provider-types';
import { StubEmbeddingProvider, StubLLMProvider } from './stub-providers';

// Must match `EMBEDDING_DIMENSIONS` in `src/db/schema/embeddings.ts`.
const SCHEMA_EMBEDDING_DIMENSIONS = 1024;

// Canonical sonnet — the user-facing default (Opus is not enabled on the
// account; ANSWER_MODEL / GENERATION_MODEL select the answer/generation model).
const BEDROCK_DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_AWS_REGION = 'eu-west-2';
const DEFAULT_TITAN_EMBED_MODEL = 'amazon.titan-embed-text-v2:0';
// Cohere Rerank v3.5 on Bedrock (override via BEDROCK_RERANK_MODEL).
const DEFAULT_COHERE_RERANK_MODEL = 'cohere.rerank-v3-5:0';
// Self-hosted open cross-encoder (override via RERANK_ENDPOINT / RERANK_MODEL).
const DEFAULT_RERANK_ENDPOINT = 'http://localhost:8080/rerank';
const DEFAULT_CROSS_ENCODER_MODEL = 'BAAI/bge-reranker-v2-m3';
// Ollama local daemon (local/desktop runtime, P1). bge-m3 embeds at 1024 dims to
// match the engine schema; the chat model is overridable via OLLAMA_MODEL.
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b';
const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'bge-m3';
// Default model for the OpenAI LLM provider (override via OPENAI_LLM_MODEL).
// A strong general model with reliable function-calling for the extraction path.
const DEFAULT_OPENAI_LLM_MODEL = 'gpt-4.1';

// Parse a positive-integer env var, or undefined when unset/invalid (so the
// consumer's own default applies). Used for optional numeric reranker bounds.
function positiveIntOr(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// ---- MUNIN_LOCAL_MODE no-egress guard (P2) --------------------------------
//
// In local mode the factory must REFUSE any provider that would send bytes
// off-machine. The refusal is structural (the provider is never constructed) and
// fail-fast (a thrown ProviderConfigurationError naming the offending provider),
// never an advisory log. Cloud LLM/embedding providers are refused by name;
// only the local Ollama daemon and the in-process stubs are permitted. The
// cross-encoder reranker is permitted ONLY against a loopback endpoint.

function localModeEnabled(env: ProviderEnv): boolean {
  return (env.MUNIN_LOCAL_MODE ?? '').toLowerCase() === 'true';
}

// ---- Deployment-posture inference (P1-1a, G1) ------------------------------
//
// The no-egress guarantee used to hang ENTIRELY on MUNIN_LOCAL_MODE=true: an
// operator who selected a local data store (GRAPH_STORE=local or
// BLOB_STORAGE_IMPL=filesystem) but forgot the flag silently fell onto the
// cloud provider defaults (LLM_PROVIDER=anthropic, EMBEDDING_PROVIDER=openai)
// and shipped every paragraph to a US endpoint while believing the stack was
// air-gapped. Posture inference closes that hole FAIL-FAST: a local store plus
// a would-egress provider and no explicit posture declaration refuses to
// construct, naming the two sanctioned configurations —
//   • MUNIN_LOCAL_MODE=true            — fully local, zero egress;
//   • MUNIN_ALLOW_CLOUD_PROVIDERS=true — local store + cloud AI (the
//     legitimate BYO-key-on-a-laptop combo), egress deliberately acknowledged.
// Pure cloud stacks are untouched. MUNIN_LOCAL_MODE WINS over the opt-in: the
// stricter promise can never be weakened by also setting the opt-in flag.

type ProviderPosture =
  | 'local' // MUNIN_LOCAL_MODE=true — the strict no-egress guard applies
  | 'cloud-permitted' // pure cloud stack, or egress explicitly acknowledged
  | 'local-store-unflagged'; // local store selected, no posture declared

function resolvePosture(env: ProviderEnv): ProviderPosture {
  if (localModeEnabled(env)) return 'local';
  if ((env.MUNIN_ALLOW_CLOUD_PROVIDERS ?? '').toLowerCase() === 'true') return 'cloud-permitted';
  const localGraph = (env.GRAPH_STORE ?? '').toLowerCase() === 'local';
  const localBlobs = (env.BLOB_STORAGE_IMPL ?? '').toLowerCase() === 'filesystem';
  return localGraph || localBlobs ? 'local-store-unflagged' : 'cloud-permitted';
}

// The fail-fast refusal for the ambiguous posture. Names the offending
// provider (which may be a silent DEFAULT the operator never chose) and the
// two deliberate one-env-var ways out.
function unflaggedLocalStoreError(
  id: string,
  kind: 'LLM' | 'embedding' | 'rerank',
  defaulted: boolean,
): ProviderConfigurationError {
  const chosen = defaulted ? `'${id}' (the silent default — no env var was set)` : `'${id}'`;
  return new ProviderConfigurationError(
    id,
    `a local data store is selected (GRAPH_STORE=local or BLOB_STORAGE_IMPL=filesystem) but no deployment posture is declared, and the ${chosen} ${kind} provider would send data off-machine. Declare the posture explicitly: set MUNIN_LOCAL_MODE=true (fully local, zero egress) or set MUNIN_ALLOW_CLOUD_PROVIDERS=true (local store + cloud AI, egress acknowledged).`,
  );
}

// Under the ambiguous posture, apply the SAME would-egress classification as
// the local-mode guard (anything that is not an in-process stub or a loopback
// daemon throws) — but with the posture error, so the operator learns the two
// sanctioned paths instead of being told local mode forbade something they
// never enabled.
function assertUnflaggedLlmAllowed(id: string, defaulted: boolean, env: ProviderEnv): void {
  if (LOCAL_MODE_REFUSED_LLM.has(id)) throw unflaggedLocalStoreError(id, 'LLM', defaulted);
  if (id === 'ollama') {
    const baseUrl = env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;
    if (!isLoopbackEndpoint(baseUrl)) throw unflaggedLocalStoreError(id, 'LLM', defaulted);
  }
}

function assertUnflaggedEmbeddingAllowed(id: string, defaulted: boolean, env: ProviderEnv): void {
  if (LOCAL_MODE_REFUSED_EMBEDDING.has(id)) {
    throw unflaggedLocalStoreError(id, 'embedding', defaulted);
  }
  if (id === 'ollama') {
    const baseUrl = env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;
    if (!isLoopbackEndpoint(baseUrl)) throw unflaggedLocalStoreError(id, 'embedding', defaulted);
  }
}

function assertUnflaggedRerankAllowed(id: string, env: ProviderEnv): void {
  switch (id) {
    case 'none':
      return;
    case 'cross-encoder': {
      const endpoint = env.RERANK_ENDPOINT?.trim() || DEFAULT_RERANK_ENDPOINT;
      if (!isLoopbackEndpoint(endpoint)) throw unflaggedLocalStoreError(id, 'rerank', false);
      return;
    }
    case 'cohere-bedrock':
    case 'llm-judge':
      throw unflaggedLocalStoreError(id, 'rerank', false);
    default:
      return; // unknown ids fall through to loadRerankProvider's own error
  }
}

// Cloud LLM providers that egress off-machine — refused in local mode. ollama
// (local daemon) and stub (in-process) are NOT here, so they pass through.
const LOCAL_MODE_REFUSED_LLM: ReadonlySet<string> = new Set(['anthropic', 'openai', 'bedrock']);
// Cloud embedding providers that egress off-machine — refused in local mode.
const LOCAL_MODE_REFUSED_EMBEDDING: ReadonlySet<string> = new Set(['openai', 'bedrock']);

// ---- MUNIN_REQUIRE_UK_RESIDENCY structural residency guard (G3-2) ---------
//
// The managed-mode posture: no AI call may leave the UK by construction.
// Mirrors the local-mode guard's shape — the refusal is structural (the
// offending provider is never constructed) and fail-fast (a thrown
// ProviderConfigurationError naming the provider), never an advisory log.
// This is an ALLOWLIST, not a denylist — anything not affirmatively known to
// be UK-resident refuses, so a future provider id cannot silently pass a
// compliance guard:
//   • LLM / embedding: ONLY bedrock pinned to eu-west-2 (London), or the
//     in-process stub.
//   • rerank: none, llm-judge (its judge LLM is built through the
//     residency-checked selector, so it inherits the same pin), or a
//     LOOPBACK cross-encoder (self-hosted in-pod/in-VM).
// Refused (by failing the allowlist): anthropic + openai (US-hosted APIs),
// cohere-bedrock (eu-central-1/Frankfurt ONLY — audit P2-7), ollama and
// remote cross-encoder endpoints (not part of the managed posture).
//
// Three structural checks on the Bedrock path itself:
//   1. EFFECTIVE region must be eu-west-2: AWS_REGION unset inherits the
//      factory default (eu-west-2) and passes — the constructed client is
//      structurally London either way; any explicit non-London value refuses.
//   2. No AWS endpoint override may be present: the SDK honours
//      AWS_ENDPOINT_URL / AWS_ENDPOINT_URL_BEDROCK_RUNTIME, which would
//      redirect traffic to an arbitrary host while AWS_REGION still reads
//      eu-west-2.
//   3. No GEOGRAPHIC cross-region inference profile: a model id like
//      'eu.anthropic.claude-…' is invocable from the London endpoint but
//      routes inference across the EU geography (Frankfurt/Paris/Dublin…) —
//      EU-resident is NOT UK-resident. Only single-region vendor-prefixed
//      ids (e.g. 'anthropic.claude-…', 'amazon.titan-…') invoke in
//      eu-west-2 alone. If London-only invocation is unavailable for a
//      model, that is a residency fact to surface to the DPO, not to paper
//      over.
//
// The flag itself parses FAIL-FAST: 'true' (any case, trimmed) enables,
// ''/'false' disables, anything else throws — a typo must never silently
// disable a compliance control. The guard COMPOSES with MUNIN_LOCAL_MODE
// (both apply; only the stub satisfies both) — neither flag weakens the
// other, and MUNIN_ALLOW_CLOUD_PROVIDERS does not weaken this guard either.

const UK_RESIDENCY_REGION = 'eu-west-2';
const UK_RESIDENCY_ALLOWED_LLM: ReadonlySet<string> = new Set(['bedrock', 'stub']);
const UK_RESIDENCY_ALLOWED_EMBEDDING: ReadonlySet<string> = new Set(['bedrock', 'stub']);
// AWS geographic cross-region inference-profile prefixes (us. / eu. / apac. /
// us-gov.), matched at the id start or after a '/' (ARN form
// …:inference-profile/eu.anthropic.…). Vendor prefixes (anthropic., amazon.,
// cohere., …) deliberately do NOT match.
const CROSS_REGION_PROFILE_PATTERN = /(^|\/)(us|us-gov|eu|apac)\./;
const AWS_ENDPOINT_OVERRIDE_VARS = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME'];

function ukResidencyEnabled(env: ProviderEnv): boolean {
  const raw = (env.MUNIN_REQUIRE_UK_RESIDENCY ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === '' || raw === 'false') return false;
  throw new ProviderConfigurationError(
    'factory',
    `MUNIN_REQUIRE_UK_RESIDENCY='${env.MUNIN_REQUIRE_UK_RESIDENCY}' is not a recognised value (use 'true' or 'false'). Refusing to guess: a typo must not silently disable the UK-residency guard.`,
  );
}

function assertUkResidencyBedrockAllowed(
  id: string,
  env: ProviderEnv,
  modelIdVars: readonly string[],
): void {
  const region = env.AWS_REGION?.trim() || DEFAULT_AWS_REGION;
  if (region !== UK_RESIDENCY_REGION) {
    throw new ProviderConfigurationError(
      id,
      `MUNIN_REQUIRE_UK_RESIDENCY=true requires the Bedrock region to be ${UK_RESIDENCY_REGION} (London); AWS_REGION='${region}' violates UK residency.`,
    );
  }
  for (const varName of AWS_ENDPOINT_OVERRIDE_VARS) {
    if (env[varName]?.trim()) {
      throw new ProviderConfigurationError(
        id,
        `MUNIN_REQUIRE_UK_RESIDENCY=true forbids the AWS endpoint override ${varName} — it would redirect Bedrock traffic away from the ${UK_RESIDENCY_REGION} (London) endpoint while AWS_REGION still reads ${UK_RESIDENCY_REGION}.`,
      );
    }
  }
  for (const varName of modelIdVars) {
    const modelId = env[varName]?.trim();
    if (modelId && CROSS_REGION_PROFILE_PATTERN.test(modelId)) {
      throw new ProviderConfigurationError(
        id,
        `MUNIN_REQUIRE_UK_RESIDENCY=true forbids the geographic cross-region inference profile ${varName}='${modelId}' — geographic profiles (us./eu./apac.) route inference ACROSS the geography (for 'eu.': Frankfurt/Paris/Dublin…), which is not UK residency. Use the single-region model id (e.g. 'anthropic.claude-…') so inference runs in ${UK_RESIDENCY_REGION} (London) only.`,
      );
    }
  }
}

const BEDROCK_LLM_MODEL_VARS = [
  'BEDROCK_MODEL_SONNET',
  'BEDROCK_MODEL_OPUS',
  'BEDROCK_MODEL_HAIKU',
] as const;
const BEDROCK_EMBED_MODEL_VARS = ['BEDROCK_EMBED_MODEL'] as const;

function assertUkResidencyLlmAllowed(id: string, env: ProviderEnv): void {
  if (!UK_RESIDENCY_ALLOWED_LLM.has(id)) {
    throw new ProviderConfigurationError(
      id,
      `MUNIN_REQUIRE_UK_RESIDENCY=true forbids the '${id}' LLM provider — it is not UK-resident by construction. UK-residency mode permits LLM_PROVIDER=bedrock (eu-west-2) or stub (tests).`,
    );
  }
  if (id === 'bedrock') assertUkResidencyBedrockAllowed('bedrock', env, BEDROCK_LLM_MODEL_VARS);
}

function assertUkResidencyEmbeddingAllowed(id: string, env: ProviderEnv): void {
  if (!UK_RESIDENCY_ALLOWED_EMBEDDING.has(id)) {
    throw new ProviderConfigurationError(
      id,
      `MUNIN_REQUIRE_UK_RESIDENCY=true forbids the '${id}' embedding provider — it is not UK-resident by construction. UK-residency mode permits EMBEDDING_PROVIDER=bedrock (eu-west-2) or stub (tests).`,
    );
  }
  if (id === 'bedrock') {
    assertUkResidencyBedrockAllowed('bedrock', env, BEDROCK_EMBED_MODEL_VARS);
  }
}

function assertUkResidencyRerankAllowed(id: string, env: ProviderEnv): void {
  switch (id) {
    case 'none':
      return;
    case 'llm-judge':
      // The judge LLM is constructed via selectLlmProvider, which applies the
      // residency check itself — structural, not assumed.
      return;
    case 'cross-encoder': {
      const endpoint = env.RERANK_ENDPOINT?.trim() || DEFAULT_RERANK_ENDPOINT;
      if (!isLoopbackEndpoint(endpoint)) {
        throw new ProviderConfigurationError(
          'cross-encoder',
          `MUNIN_REQUIRE_UK_RESIDENCY=true forbids a remote reranker endpoint (RERANK_ENDPOINT='${endpoint}') — residency of an arbitrary host cannot be verified structurally. UK-residency mode permits the cross-encoder only against a loopback host (localhost/127.0.0.1/::1).`,
        );
      }
      return;
    }
    case 'cohere-bedrock':
      throw new ProviderConfigurationError(
        'cohere-bedrock',
        `MUNIN_REQUIRE_UK_RESIDENCY=true forbids the 'cohere-bedrock' reranker — Cohere on Bedrock is eu-central-1 (Frankfurt) ONLY, ruled out on UK residency (audit P2-7). UK-residency mode permits RERANK_PROVIDER=none, llm-judge, or a loopback cross-encoder.`,
      );
    default:
      return; // unknown ids fall through to loadRerankProvider's own error
  }
}

// Loopback-only hosts the cross-encoder may target in local mode (a local
// rerank daemon). Anything else is off-machine egress and is refused. The
// loopback definition (canonical three spellings, fail-closed on anything
// else) lives in local-egress-guard.ts — ONE source of truth shared with the
// network-level dispatcher, so the two layers can never drift apart.
const isLoopbackEndpoint = isLoopbackUrl;

// The Ollama daemon must itself be loopback in local mode — a remote
// OLLAMA_BASE_URL (e.g. a hosted Ollama-compatible API) is off-machine egress
// just as much as a cloud provider, so the same loopback gate applies.
function assertLocalOllamaEndpoint(providerId: string, env: ProviderEnv): void {
  const baseUrl = env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;
  if (!isLoopbackEndpoint(baseUrl)) {
    throw new ProviderConfigurationError(
      providerId,
      `MUNIN_LOCAL_MODE=true requires a loopback OLLAMA_BASE_URL (localhost/127.0.0.1/::1); '${baseUrl}' is off-machine.`,
    );
  }
}

function assertLocalModeLlmAllowed(id: string, env: ProviderEnv): void {
  if (LOCAL_MODE_REFUSED_LLM.has(id)) {
    throw new ProviderConfigurationError(
      id,
      `MUNIN_LOCAL_MODE=true forbids the '${id}' LLM provider — it sends prompts off-machine. Local mode permits only LLM_PROVIDER=ollama (local daemon) or stub (tests).`,
    );
  }
  if (id === 'ollama') assertLocalOllamaEndpoint('ollama', env);
}

function assertLocalModeEmbeddingAllowed(id: string, env: ProviderEnv): void {
  if (LOCAL_MODE_REFUSED_EMBEDDING.has(id)) {
    throw new ProviderConfigurationError(
      id,
      `MUNIN_LOCAL_MODE=true forbids the '${id}' embedding provider — it sends text off-machine. Local mode permits only EMBEDDING_PROVIDER=ollama (local daemon) or stub (tests).`,
    );
  }
  if (id === 'ollama') assertLocalOllamaEndpoint('ollama', env);
}

// Reranker disposition in local mode: none → ok; cross-encoder → loopback-only;
// cohere-bedrock / llm-judge → refused (both egress; the reranker is optional
// locally, so llm-judge is refused outright rather than chasing its LLM's
// locality). Unknown ids fall through to loadRerankProvider's own error.
function assertLocalModeRerankAllowed(id: string, env: ProviderEnv): void {
  switch (id) {
    case 'none':
      return;
    case 'cross-encoder': {
      const endpoint = env.RERANK_ENDPOINT?.trim() || DEFAULT_RERANK_ENDPOINT;
      if (!isLoopbackEndpoint(endpoint)) {
        throw new ProviderConfigurationError(
          'cross-encoder',
          `MUNIN_LOCAL_MODE=true forbids a remote reranker endpoint (RERANK_ENDPOINT='${endpoint}'). Local mode permits the cross-encoder only against a loopback host (localhost/127.0.0.1/::1).`,
        );
      }
      return;
    }
    case 'cohere-bedrock':
    case 'llm-judge':
      throw new ProviderConfigurationError(
        id,
        `MUNIN_LOCAL_MODE=true forbids the '${id}' reranker — it egresses off-machine. Local mode permits RERANK_PROVIDER=none or a loopback cross-encoder.`,
      );
    default:
      return;
  }
}

export interface ProviderEnv {
  readonly LLM_PROVIDER?: string;
  readonly EMBEDDING_PROVIDER?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_MODEL_DEFAULT?: string;
  readonly OPENAI_API_KEY?: string;
  // Default LLM model for LLM_PROVIDER=openai (a US-hosted dev/BYO-key path,
  // refused in local + UK-residency modes). Overridable per request.
  readonly OPENAI_LLM_MODEL?: string;
  readonly OPENAI_EMBEDDING_MODEL?: string;
  readonly OPENAI_EMBEDDING_DIMENSIONS?: string;
  // Ollama (local/desktop runtime, P1). A local daemon — zero network egress.
  readonly OLLAMA_BASE_URL?: string;
  readonly OLLAMA_MODEL?: string;
  readonly OLLAMA_EMBEDDING_MODEL?: string;
  // Per-request budget for BOTH Ollama providers (P2-10). Unset → generous
  // per-provider defaults (120s chat / 30s embed); raise for slow hardware.
  readonly OLLAMA_TIMEOUT_MS?: string;
  // AWS Bedrock (eu-west-2). Auth is the bearer token AWS_BEARER_TOKEN_BEDROCK,
  // read by the SDK directly (not here); these name the region + model ids.
  readonly AWS_REGION?: string;
  // SDK endpoint overrides — never set by Munin; read ONLY so the UK-residency
  // guard can refuse them (they would redirect Bedrock traffic off-region).
  readonly AWS_ENDPOINT_URL?: string;
  readonly AWS_ENDPOINT_URL_BEDROCK_RUNTIME?: string;
  readonly BEDROCK_MODEL_OPUS?: string;
  readonly BEDROCK_MODEL_SONNET?: string;
  readonly BEDROCK_MODEL_HAIKU?: string;
  readonly BEDROCK_EMBED_MODEL?: string;
  // Reranking. RERANK_PROVIDER selects the reranker; RERANK_MODEL names the judge
  // model for the llm-judge reranker (default Sonnet — the strongest in-region
  // discriminator; RERANK_JUDGE_MODEL is the legacy alias). RERANK_MAX_DOCS caps
  // how many candidates the judge re-scores in one prompt (must be ≥ the config's
  // rerankCandidates to cover the pool at scale); RERANK_PER_DOC_CHARS bounds each
  // candidate's prompt length (trim it for very wide pools to keep the prompt sane).
  readonly RERANK_PROVIDER?: string;
  readonly RERANK_MODEL?: string;
  readonly RERANK_JUDGE_MODEL?: string;
  readonly RERANK_MAX_DOCS?: string;
  readonly RERANK_PER_DOC_CHARS?: string;
  // Self-hosted cross-encoder /rerank endpoint (RERANK_PROVIDER=cross-encoder).
  readonly RERANK_ENDPOINT?: string;
  readonly RERANK_TIMEOUT_MS?: string;
  // Dev cost control: `haiku` routes all LLM calls through Haiku 4.5.
  readonly MUNIN_DEV_MODE?: string;
  // Local/desktop runtime no-egress guard (P2). When 'true', the factory REFUSES
  // to construct any provider that would call off-machine — the privacy promise
  // ("zero network egress in local mode") becomes a structural, fail-fast
  // guarantee rather than an operator convention. Only ollama/stub LLM +
  // embedding and a loopback cross-encoder (or no reranker) are permitted.
  readonly MUNIN_LOCAL_MODE?: string;
  // Posture inference inputs (P1-1a). The factory never constructs stores or
  // blob backends — it reads these two selectors ONLY to detect the ambiguous
  // "local store but no posture declared" configuration and fail fast instead
  // of silently defaulting onto a cloud provider.
  readonly GRAPH_STORE?: string;
  readonly BLOB_STORAGE_IMPL?: string;
  // Explicit egress acknowledgement for the local-store + cloud-AI combo
  // (BYO-key on a laptop). Ignored when MUNIN_LOCAL_MODE=true — the stricter
  // promise always wins.
  readonly MUNIN_ALLOW_CLOUD_PROVIDERS?: string;
  // Managed-mode structural residency guard (G3-2). When 'true', the factory
  // REFUSES any provider that is not UK-resident by construction: only
  // bedrock pinned to eu-west-2 (or stub) for LLM/embedding, and
  // none / llm-judge / loopback cross-encoder for reranking. The pilot rig
  // sets this; it composes with (never weakens) MUNIN_LOCAL_MODE.
  readonly MUNIN_REQUIRE_UK_RESIDENCY?: string;
  // Index signature so `process.env` (a string map) is assignable regardless of
  // a consumer's ProcessEnv typing (Next augments ProcessEnv differently than
  // @types/node). The named fields above document the vars actually read.
  readonly [key: string]: string | undefined;
}

export function loadProvidersFromEnv(env: ProviderEnv = process.env): ProviderBundle {
  const rerank = loadRerankProvider(env);
  return {
    llm: loadLlmProvider(env),
    embedding: loadEmbeddingProvider(env),
    ...(rerank ? { rerank } : {}),
  };
}

// Optional reranker, selected by RERANK_PROVIDER. Unset / 'none' → no reranking
// (the retrieval path is unchanged). 'cohere-bedrock' → the purpose-built Cohere
// cross-encoder on Bedrock — eu-central-1 (Frankfurt) ONLY, NOT available in
// eu-west-2 (London), so it is RULED OUT on UK residency and is NOT the
// preferred/UK reranker (the UK-safe reranker is the self-hosted 'cross-encoder';
//). It stays selectable for non-residency
// contexts. 'llm-judge' → an in-region LLM judge, available
// wherever Claude is (Bedrock eu-west-2). Its default judge is SONNET, not Haiku:
// at 10k scale the failure is discriminating documents that differ mainly by a
// person's name, and Haiku cannot tell those look-alikes apart reliably; Sonnet
// is the stronger UK-safe discriminator. Override the judge model via RERANK_MODEL.
export function loadRerankProvider(env: ProviderEnv = process.env): RerankProvider | undefined {
  const id = (env.RERANK_PROVIDER ?? 'none').toLowerCase();
  const posture = resolvePosture(env);
  if (posture === 'local') {
    installLocalModeEgressGuard(); // defence-in-depth: loopback-only fetch (P1-1b)
    assertLocalModeRerankAllowed(id, env);
  } else if (posture === 'local-store-unflagged') {
    assertUnflaggedRerankAllowed(id, env);
  }
  if (ukResidencyEnabled(env)) assertUkResidencyRerankAllowed(id, env);
  switch (id) {
    case 'none':
      return undefined;
    case 'cohere-bedrock': {
      const region = env.AWS_REGION?.trim() || DEFAULT_AWS_REGION;
      const modelId = env.BEDROCK_RERANK_MODEL?.trim() || DEFAULT_COHERE_RERANK_MODEL;
      return new BedrockCohereRerankProvider({ region, modelId });
    }
    case 'llm-judge': {
      // Judge with Sonnet (default) via whichever LLM provider is configured
      // (Bedrock in prod → eu-west-2, UK). RERANK_MODEL overrides; RERANK_JUDGE_MODEL
      // is the legacy alias. The reranker only ever re-orders the already-retrieved,
      // permission-filtered candidate set handed to it — it fetches nothing.
      const model =
        env.RERANK_MODEL?.trim() || env.RERANK_JUDGE_MODEL?.trim() || BEDROCK_DEFAULT_MODEL;
      const maxDocuments = positiveIntOr(env.RERANK_MAX_DOCS);
      const perDocChars = positiveIntOr(env.RERANK_PER_DOC_CHARS);
      return new LlmJudgeRerankProvider({
        llm: selectLlmProvider(env),
        model,
        ...(maxDocuments !== undefined ? { maxDocuments } : {}),
        ...(perDocChars !== undefined ? { perDocChars } : {}),
      });
    }
    case 'cross-encoder': {
      // Self-hosted open cross-encoder over HTTP (default BAAI/bge-reranker-v2-m3),
      // served locally/UK (tools/rerank-server in dev; TEI in x86 prod) on
      // RERANK_ENDPOINT. A real cross-encoder reads the (query, doc) PAIR jointly,
      // so it discriminates near-identical look-alikes an LLM judge cannot — and it
      // is free per query. It only re-orders the permission-filtered candidate set.
      const endpoint = env.RERANK_ENDPOINT?.trim() || DEFAULT_RERANK_ENDPOINT;
      const modelId = env.RERANK_MODEL?.trim() || DEFAULT_CROSS_ENCODER_MODEL;
      const maxDocuments = positiveIntOr(env.RERANK_MAX_DOCS);
      const perDocChars = positiveIntOr(env.RERANK_PER_DOC_CHARS);
      const timeoutMs = positiveIntOr(env.RERANK_TIMEOUT_MS);
      return new HttpCrossEncoderRerankProvider({
        endpoint,
        modelId,
        ...(maxDocuments !== undefined ? { maxDocuments } : {}),
        ...(perDocChars !== undefined ? { perDocChars } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
    default:
      throw new ProviderConfigurationError(
        'factory',
        `unknown RERANK_PROVIDER='${id}'. Supported: none, cohere-bedrock, llm-judge, cross-encoder`,
      );
  }
}

export function loadLlmProvider(env: ProviderEnv = process.env): LLMProvider {
  const base = selectLlmProvider(env);
  // Dev cost control applies regardless of which provider was selected.
  if ((env.MUNIN_DEV_MODE ?? '').toLowerCase() === 'haiku') {
    return withForcedModel(base, DEV_HAIKU_MODEL);
  }
  return base;
}

function selectLlmProvider(env: ProviderEnv): LLMProvider {
  const id = (env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  const posture = resolvePosture(env);
  if (posture === 'local') {
    installLocalModeEgressGuard(); // defence-in-depth: loopback-only fetch (P1-1b)
    assertLocalModeLlmAllowed(id, env);
  } else if (posture === 'local-store-unflagged') {
    assertUnflaggedLlmAllowed(id, env.LLM_PROVIDER === undefined, env);
  }
  if (ukResidencyEnabled(env)) assertUkResidencyLlmAllowed(id, env);
  switch (id) {
    case 'stub':
      return new StubLLMProvider();
    case 'anthropic': {
      const apiKey = env.ANTHROPIC_API_KEY;
      const defaultModel = env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6';
      if (!apiKey) {
        throw new ProviderConfigurationError(
          'anthropic',
          'ANTHROPIC_API_KEY is not set in the environment',
        );
      }
      return new AnthropicLLMProvider({ apiKey, defaultModel });
    }
    case 'openai': {
      const apiKey = env.OPENAI_API_KEY;
      const defaultModel = env.OPENAI_LLM_MODEL?.trim() || DEFAULT_OPENAI_LLM_MODEL;
      if (!apiKey) {
        throw new ProviderConfigurationError(
          'openai',
          'OPENAI_API_KEY is not set in the environment',
        );
      }
      return new OpenAILLMProvider({ apiKey, defaultModel });
    }
    case 'bedrock': {
      const region = env.AWS_REGION?.trim() || DEFAULT_AWS_REGION;
      const sonnet = env.BEDROCK_MODEL_SONNET?.trim();
      if (!sonnet) {
        throw new ProviderConfigurationError(
          'bedrock',
          'BEDROCK_MODEL_SONNET is required (the default answer/generation family)',
        );
      }
      return new BedrockLLMProvider({
        region,
        defaultModel: BEDROCK_DEFAULT_MODEL,
        modelProfiles: {
          sonnet,
          ...(env.BEDROCK_MODEL_OPUS?.trim() ? { opus: env.BEDROCK_MODEL_OPUS.trim() } : {}),
          ...(env.BEDROCK_MODEL_HAIKU?.trim() ? { haiku: env.BEDROCK_MODEL_HAIKU.trim() } : {}),
        },
      });
    }
    case 'ollama': {
      const baseUrl = env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;
      const defaultModel = env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
      const timeoutMs = positiveIntOr(env.OLLAMA_TIMEOUT_MS);
      return new OllamaLLMProvider({
        baseUrl,
        defaultModel,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
    default:
      throw new ProviderConfigurationError(
        'factory',
        `unknown LLM_PROVIDER='${id}'. Supported: anthropic (dev), openai (dev/BYO-key), bedrock (eu-west-2), ollama (local), stub (dev/UI)`,
      );
  }
}

export function loadEmbeddingProvider(env: ProviderEnv = process.env): EmbeddingProvider {
  const id = (env.EMBEDDING_PROVIDER ?? 'openai').toLowerCase();
  const posture = resolvePosture(env);
  if (posture === 'local') {
    installLocalModeEgressGuard(); // defence-in-depth: loopback-only fetch (P1-1b)
    assertLocalModeEmbeddingAllowed(id, env);
  } else if (posture === 'local-store-unflagged') {
    assertUnflaggedEmbeddingAllowed(id, env.EMBEDDING_PROVIDER === undefined, env);
  }
  if (ukResidencyEnabled(env)) assertUkResidencyEmbeddingAllowed(id, env);
  switch (id) {
    case 'stub':
      return new StubEmbeddingProvider();
    case 'openai': {
      const apiKey = env.OPENAI_API_KEY;
      const modelId = env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
      const dimensions = Number.parseInt(env.OPENAI_EMBEDDING_DIMENSIONS ?? '1024', 10);
      if (!apiKey) {
        throw new ProviderConfigurationError(
          'openai',
          'OPENAI_API_KEY is not set in the environment',
        );
      }
      if (!Number.isFinite(dimensions) || dimensions <= 0) {
        throw new ProviderConfigurationError(
          'openai',
          `OPENAI_EMBEDDING_DIMENSIONS='${env.OPENAI_EMBEDDING_DIMENSIONS}' is not a positive integer`,
        );
      }
      if (dimensions !== SCHEMA_EMBEDDING_DIMENSIONS) {
        throw new ProviderConfigurationError(
          'openai',
          `OPENAI_EMBEDDING_DIMENSIONS=${dimensions} does not match the engine schema's vector(${SCHEMA_EMBEDDING_DIMENSIONS}). Regenerate the migration or correct the env var.`,
        );
      }
      return new OpenAIEmbeddingProvider({ apiKey, modelId, dimensions });
    }
    case 'bedrock': {
      const region = env.AWS_REGION?.trim() || DEFAULT_AWS_REGION;
      const modelId = env.BEDROCK_EMBED_MODEL?.trim() || DEFAULT_TITAN_EMBED_MODEL;
      // Fixed to the schema dimension; Titan v2 truncates its output to match.
      return new BedrockTitanEmbeddingProvider({
        region,
        modelId,
        dimensions: SCHEMA_EMBEDDING_DIMENSIONS,
      });
    }
    case 'ollama': {
      const baseUrl = env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;
      const modelId = env.OLLAMA_EMBEDDING_MODEL?.trim() || DEFAULT_OLLAMA_EMBEDDING_MODEL;
      const timeoutMs = positiveIntOr(env.OLLAMA_TIMEOUT_MS);
      // Fixed to the schema dimension; the provider FAILS FAST if the local
      // model returns a different size (a mismatched local index is invalid).
      return new OllamaEmbeddingProvider({
        baseUrl,
        modelId,
        dimensions: SCHEMA_EMBEDDING_DIMENSIONS,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
    default:
      throw new ProviderConfigurationError(
        'factory',
        `unknown EMBEDDING_PROVIDER='${id}'. Supported: openai (dev), bedrock (eu-west-2), ollama (local), stub (dev/UI)`,
      );
  }
}
