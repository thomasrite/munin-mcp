import { afterAll, describe, expect, it } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import { asTenantId } from '../graph/types';
import type { NewLlmCall } from '../graph/types';
import { DEV_HAIKU_MODEL, withForcedModel } from './dev-model-override';
import { uninstallLocalModeEgressGuardForTests } from './local-egress-guard';
import { ProviderConfigurationError } from './provider-errors';
import {
  loadEmbeddingProvider,
  loadLlmProvider,
  loadProvidersFromEnv,
  loadRerankProvider,
} from './provider-factory';
import type { LLMProvider, LLMRequest, LLMTool, ProviderCallContext } from './provider-types';

// Capture insertLlmCall without a database. Only the one method is exercised.
function fakeCallContext(): {
  ctx: ProviderCallContext;
  calls: Array<{ region: string; modelId: string }>;
} {
  const calls: Array<{ region: string; modelId: string }> = [];
  const graphStore = {
    async insertLlmCall(_c: unknown, params: NewLlmCall): Promise<void> {
      calls.push({ region: params.region, modelId: params.modelId });
    },
    // reason: the stub only ever calls insertLlmCall; the rest of the writer
    // surface is irrelevant to these tests.
  } as unknown as GraphStoreWriter;
  return {
    ctx: {
      tenantId: asTenantId('00000000-0000-0000-0000-000000000001'),
      purpose: 'query',
      graphStore,
    },
    calls,
  };
}

// Local-mode factory calls install the process-global egress dispatcher as a
// side effect; restore it so this file leaves the worker's dispatch state
// clean (vitest isolates per file, but explicit hygiene beats relying on it).
afterAll(() => {
  uninstallLocalModeEgressGuardForTests();
});

const answerTool: LLMTool = {
  name: 'submit_answer',
  description: 'answer',
  inputSchema: { type: 'object', properties: { status: {}, answer: {}, citations: {} } },
};
const extractTool: LLMTool = {
  name: 'extract',
  description: 'extract',
  inputSchema: { type: 'object', properties: { entities: {}, relationships: {} } },
};

describe('provider factory — stub selection', () => {
  it('selects the stub LLM provider with no API key', () => {
    const llm = loadLlmProvider({ LLM_PROVIDER: 'stub' });
    expect(llm.id).toBe('stub-llm');
  });

  it('selects the stub embedding provider with no API key', () => {
    const embedding = loadEmbeddingProvider({ EMBEDDING_PROVIDER: 'stub' });
    expect(embedding.id).toBe('stub-embed');
    expect(embedding.dimensions).toBe(1024);
  });

  it('loads a full stub bundle with an empty env (zero spend, no keys required)', () => {
    const bundle = loadProvidersFromEnv({ LLM_PROVIDER: 'stub', EMBEDDING_PROVIDER: 'stub' });
    expect(bundle.llm.id).toBe('stub-llm');
    expect(bundle.embedding.id).toBe('stub-embed');
  });
});

describe('reranker selection (RERANK_PROVIDER / RERANK_MODEL)', () => {
  it('returns no reranker by default (RERANK_PROVIDER unset → retrieval unchanged)', () => {
    expect(loadRerankProvider({ LLM_PROVIDER: 'stub' })).toBeUndefined();
    expect(loadRerankProvider({ LLM_PROVIDER: 'stub', RERANK_PROVIDER: 'none' })).toBeUndefined();
  });

  it('llm-judge judges with Sonnet by default (the UK-safe discriminator, not Haiku)', () => {
    const rerank = loadRerankProvider({ LLM_PROVIDER: 'stub', RERANK_PROVIDER: 'llm-judge' });
    expect(rerank?.id).toBe('llm-judge');
    expect(rerank?.modelId).toBe('claude-sonnet-4-6');
    // It must NOT default to the cheap dev Haiku model — that is the look-alike
    // failure mode the scale fix moves away from.
    expect(rerank?.modelId).not.toBe(DEV_HAIKU_MODEL);
  });

  it('RERANK_MODEL overrides the judge model; RERANK_JUDGE_MODEL is the legacy alias', () => {
    const viaNew = loadRerankProvider({
      LLM_PROVIDER: 'stub',
      RERANK_PROVIDER: 'llm-judge',
      RERANK_MODEL: 'claude-opus-4-7',
    });
    expect(viaNew?.modelId).toBe('claude-opus-4-7');

    const viaLegacy = loadRerankProvider({
      LLM_PROVIDER: 'stub',
      RERANK_PROVIDER: 'llm-judge',
      RERANK_JUDGE_MODEL: 'legacy-model',
    });
    expect(viaLegacy?.modelId).toBe('legacy-model');

    // RERANK_MODEL wins over the legacy alias when both are set.
    const both = loadRerankProvider({
      LLM_PROVIDER: 'stub',
      RERANK_PROVIDER: 'llm-judge',
      RERANK_MODEL: 'new-wins',
      RERANK_JUDGE_MODEL: 'legacy-loses',
    });
    expect(both?.modelId).toBe('new-wins');
  });

  it('RERANK_MAX_DOCS raises the judge candidate cap (cover the wide pool at scale)', () => {
    const dflt = loadRerankProvider({ LLM_PROVIDER: 'stub', RERANK_PROVIDER: 'llm-judge' });
    expect(dflt?.maxDocuments).toBe(60); // engine default

    const wide = loadRerankProvider({
      LLM_PROVIDER: 'stub',
      RERANK_PROVIDER: 'llm-judge',
      RERANK_MAX_DOCS: '200',
    });
    expect(wide?.maxDocuments).toBe(200);

    // A non-positive / malformed value is ignored (falls back to the default).
    const bad = loadRerankProvider({
      LLM_PROVIDER: 'stub',
      RERANK_PROVIDER: 'llm-judge',
      RERANK_MAX_DOCS: 'nope',
    });
    expect(bad?.maxDocuments).toBe(60);
  });
});

describe('MUNIN_LOCAL_MODE no-egress guard (P2)', () => {
  const LOCAL = { MUNIN_LOCAL_MODE: 'true' } as const;

  describe('LLM provider', () => {
    it('REFUSES anthropic (off-machine) — fail-fast naming the provider', () => {
      expect(() =>
        loadLlmProvider({ ...LOCAL, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' }),
      ).toThrow(ProviderConfigurationError);
      expect(() =>
        loadLlmProvider({ ...LOCAL, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' }),
      ).toThrow(/anthropic/);
    });

    it('REFUSES bedrock (off-machine)', () => {
      expect(() =>
        loadLlmProvider({ ...LOCAL, LLM_PROVIDER: 'bedrock', BEDROCK_MODEL_SONNET: 'm' }),
      ).toThrow(ProviderConfigurationError);
    });

    it('REFUSES openai (off-machine, US cloud) — fail-fast naming the provider', () => {
      expect(() =>
        loadLlmProvider({ ...LOCAL, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }),
      ).toThrow(ProviderConfigurationError);
      expect(() =>
        loadLlmProvider({ ...LOCAL, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }),
      ).toThrow(/openai/);
    });

    it('REFUSES the default (anthropic) when LLM_PROVIDER is unset', () => {
      // Local mode must not silently fall back to a cloud default.
      expect(() => loadLlmProvider({ ...LOCAL, ANTHROPIC_API_KEY: 'sk-x' })).toThrow(
        ProviderConfigurationError,
      );
    });

    it('ALLOWS ollama (local daemon, default loopback base URL)', () => {
      const llm = loadLlmProvider({ ...LOCAL, LLM_PROVIDER: 'ollama' });
      expect(llm.id).toBe('ollama');
    });

    it('REFUSES ollama pointed at a remote OLLAMA_BASE_URL (off-machine daemon)', () => {
      expect(() =>
        loadLlmProvider({
          ...LOCAL,
          LLM_PROVIDER: 'ollama',
          OLLAMA_BASE_URL: 'http://ollama.example.com:11434',
        }),
      ).toThrow(ProviderConfigurationError);
    });

    it('ALLOWS stub (in-process, tests)', () => {
      const llm = loadLlmProvider({ ...LOCAL, LLM_PROVIDER: 'stub' });
      expect(llm.id).toBe('stub-llm');
    });
  });

  describe('embedding provider', () => {
    it('REFUSES openai (off-machine)', () => {
      expect(() =>
        loadEmbeddingProvider({ ...LOCAL, EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }),
      ).toThrow(ProviderConfigurationError);
      expect(() =>
        loadEmbeddingProvider({ ...LOCAL, EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }),
      ).toThrow(/openai/);
    });

    it('REFUSES bedrock (off-machine)', () => {
      expect(() => loadEmbeddingProvider({ ...LOCAL, EMBEDDING_PROVIDER: 'bedrock' })).toThrow(
        ProviderConfigurationError,
      );
    });

    it('REFUSES the default (openai) when EMBEDDING_PROVIDER is unset', () => {
      expect(() => loadEmbeddingProvider({ ...LOCAL, OPENAI_API_KEY: 'sk-x' })).toThrow(
        ProviderConfigurationError,
      );
    });

    it('ALLOWS ollama (local daemon, default loopback base URL)', () => {
      const embedding = loadEmbeddingProvider({ ...LOCAL, EMBEDDING_PROVIDER: 'ollama' });
      expect(embedding.id).toBe('ollama');
      expect(embedding.dimensions).toBe(1024);
    });

    it('REFUSES ollama pointed at a remote OLLAMA_BASE_URL (off-machine daemon)', () => {
      expect(() =>
        loadEmbeddingProvider({
          ...LOCAL,
          EMBEDDING_PROVIDER: 'ollama',
          OLLAMA_BASE_URL: 'http://ollama.example.com:11434',
        }),
      ).toThrow(ProviderConfigurationError);
    });

    it('ALLOWS stub (in-process, tests)', () => {
      const embedding = loadEmbeddingProvider({ ...LOCAL, EMBEDDING_PROVIDER: 'stub' });
      expect(embedding.id).toBe('stub-embed');
    });
  });

  describe('reranker', () => {
    it('ALLOWS none (no reranking)', () => {
      expect(loadRerankProvider({ ...LOCAL, RERANK_PROVIDER: 'none' })).toBeUndefined();
      expect(loadRerankProvider({ ...LOCAL })).toBeUndefined(); // unset → none
    });

    it('REFUSES cohere-bedrock always (Frankfurt, off-machine)', () => {
      expect(() => loadRerankProvider({ ...LOCAL, RERANK_PROVIDER: 'cohere-bedrock' })).toThrow(
        ProviderConfigurationError,
      );
    });

    it('REFUSES llm-judge (optional locally; refused outright)', () => {
      expect(() =>
        loadRerankProvider({ ...LOCAL, RERANK_PROVIDER: 'llm-judge', LLM_PROVIDER: 'ollama' }),
      ).toThrow(ProviderConfigurationError);
    });

    it('ALLOWS cross-encoder against a loopback endpoint (default localhost)', () => {
      const dflt = loadRerankProvider({ ...LOCAL, RERANK_PROVIDER: 'cross-encoder' });
      expect(dflt?.id).toBe('cross-encoder');
      for (const endpoint of [
        'http://localhost:8080/rerank',
        'http://127.0.0.1:9000/rerank',
        'http://[::1]:8080/rerank',
      ]) {
        const rerank = loadRerankProvider({
          ...LOCAL,
          RERANK_PROVIDER: 'cross-encoder',
          RERANK_ENDPOINT: endpoint,
        });
        expect(rerank?.id).toBe('cross-encoder');
      }
    });

    it('REFUSES a remote cross-encoder endpoint (off-machine)', () => {
      expect(() =>
        loadRerankProvider({
          ...LOCAL,
          RERANK_PROVIDER: 'cross-encoder',
          RERANK_ENDPOINT: 'http://rerank.example.com/rerank',
        }),
      ).toThrow(ProviderConfigurationError);
    });
  });

  it('loads a fully-local bundle (ollama + ollama + loopback cross-encoder) with no egress path', () => {
    const bundle = loadProvidersFromEnv({
      ...LOCAL,
      LLM_PROVIDER: 'ollama',
      EMBEDDING_PROVIDER: 'ollama',
      RERANK_PROVIDER: 'cross-encoder',
    });
    expect(bundle.llm.id).toBe('ollama');
    expect(bundle.embedding.id).toBe('ollama');
    expect(bundle.rerank?.id).toBe('cross-encoder');
  });

  it('the bundle entry point also refuses a cloud provider in local mode (no bypass via loadProvidersFromEnv)', () => {
    expect(() =>
      loadProvidersFromEnv({ ...LOCAL, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' }),
    ).toThrow(ProviderConfigurationError);
  });

  it('does NOT constrain provider choice when MUNIN_LOCAL_MODE is unset (cloud still allowed)', () => {
    const llm = loadLlmProvider({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' });
    expect(llm.id).toBe('anthropic');
  });
});

describe('deployment-posture inference (P1-1a) — local store without a posture flag', () => {
  // The hole this closes: GRAPH_STORE=local (or BLOB_STORAGE_IMPL=filesystem)
  // with MUNIN_LOCAL_MODE forgotten used to fall silently onto the cloud
  // defaults and egress every paragraph. Now the ambiguous posture fails fast.
  const LOCAL_GRAPH = { GRAPH_STORE: 'local' } as const;
  const LOCAL_BLOBS = { BLOB_STORAGE_IMPL: 'filesystem' } as const;

  describe('local store + nothing → throws naming the (possibly defaulted) cloud provider', () => {
    it('embedding: the SILENT openai default is refused and named', () => {
      expect(() => loadEmbeddingProvider({ ...LOCAL_GRAPH, OPENAI_API_KEY: 'sk-x' })).toThrow(
        ProviderConfigurationError,
      );
      expect(() => loadEmbeddingProvider({ ...LOCAL_GRAPH, OPENAI_API_KEY: 'sk-x' })).toThrow(
        /'openai' \(the silent default/,
      );
      expect(() => loadEmbeddingProvider({ ...LOCAL_GRAPH, OPENAI_API_KEY: 'sk-x' })).toThrow(
        /MUNIN_LOCAL_MODE=true.*MUNIN_ALLOW_CLOUD_PROVIDERS=true/,
      );
    });

    it('LLM: the silent anthropic default is refused and named', () => {
      expect(() => loadLlmProvider({ ...LOCAL_GRAPH, ANTHROPIC_API_KEY: 'sk-x' })).toThrow(
        /'anthropic' \(the silent default/,
      );
    });

    it('an EXPLICIT cloud choice is refused too (without the default wording)', () => {
      expect(() =>
        loadEmbeddingProvider({ ...LOCAL_GRAPH, EMBEDDING_PROVIDER: 'bedrock' }),
      ).toThrow(/'bedrock' embedding provider would send data off-machine/);
      expect(() =>
        loadLlmProvider({ ...LOCAL_GRAPH, LLM_PROVIDER: 'bedrock', BEDROCK_MODEL_SONNET: 'm' }),
      ).toThrow(ProviderConfigurationError);
    });

    it('BLOB_STORAGE_IMPL=filesystem alone also triggers the inference', () => {
      expect(() => loadEmbeddingProvider({ ...LOCAL_BLOBS, OPENAI_API_KEY: 'sk-x' })).toThrow(
        ProviderConfigurationError,
      );
    });

    it('cloud rerankers are refused; a remote cross-encoder endpoint too', () => {
      expect(() =>
        loadRerankProvider({ ...LOCAL_GRAPH, RERANK_PROVIDER: 'cohere-bedrock' }),
      ).toThrow(ProviderConfigurationError);
      expect(() => loadRerankProvider({ ...LOCAL_GRAPH, RERANK_PROVIDER: 'llm-judge' })).toThrow(
        ProviderConfigurationError,
      );
      expect(() =>
        loadRerankProvider({
          ...LOCAL_GRAPH,
          RERANK_PROVIDER: 'cross-encoder',
          RERANK_ENDPOINT: 'http://rerank.example.com/rerank',
        }),
      ).toThrow(ProviderConfigurationError);
    });

    it('a remote OLLAMA_BASE_URL is off-machine egress and refused', () => {
      expect(() =>
        loadLlmProvider({
          ...LOCAL_GRAPH,
          LLM_PROVIDER: 'ollama',
          OLLAMA_BASE_URL: 'http://ollama.example.com:11434',
        }),
      ).toThrow(ProviderConfigurationError);
    });

    it('genuinely-local providers still construct (stub, loopback ollama, loopback reranker, none)', () => {
      expect(loadLlmProvider({ ...LOCAL_GRAPH, LLM_PROVIDER: 'stub' }).id).toBe('stub-llm');
      expect(loadLlmProvider({ ...LOCAL_GRAPH, LLM_PROVIDER: 'ollama' }).id).toBe('ollama');
      expect(loadEmbeddingProvider({ ...LOCAL_GRAPH, EMBEDDING_PROVIDER: 'ollama' }).id).toBe(
        'ollama',
      );
      expect(loadRerankProvider({ ...LOCAL_GRAPH })).toBeUndefined();
      expect(loadRerankProvider({ ...LOCAL_GRAPH, RERANK_PROVIDER: 'cross-encoder' })?.id).toBe(
        'cross-encoder',
      );
    });
  });

  describe('+ MUNIN_LOCAL_MODE=true → the existing strict guard (its message, not the posture one)', () => {
    it('cloud providers are refused with the local-mode wording', () => {
      expect(() =>
        loadEmbeddingProvider({
          ...LOCAL_GRAPH,
          MUNIN_LOCAL_MODE: 'true',
          OPENAI_API_KEY: 'sk-x',
        }),
      ).toThrow(/MUNIN_LOCAL_MODE=true forbids/);
    });

    it('the fully-local bundle constructs', () => {
      const bundle = loadProvidersFromEnv({
        ...LOCAL_GRAPH,
        MUNIN_LOCAL_MODE: 'true',
        LLM_PROVIDER: 'ollama',
        EMBEDDING_PROVIDER: 'ollama',
      });
      expect(bundle.llm.id).toBe('ollama');
      expect(bundle.embedding.id).toBe('ollama');
    });
  });

  describe('+ MUNIN_ALLOW_CLOUD_PROVIDERS=true → cloud providers construct (egress acknowledged)', () => {
    const OPTED_IN = { ...LOCAL_GRAPH, MUNIN_ALLOW_CLOUD_PROVIDERS: 'true' } as const;

    it('the BYO-key-on-a-laptop combo works: local store + cloud LLM/embedding', () => {
      expect(loadLlmProvider({ ...OPTED_IN, ANTHROPIC_API_KEY: 'sk-x' }).id).toBe('anthropic');
      expect(loadEmbeddingProvider({ ...OPTED_IN, OPENAI_API_KEY: 'sk-x' }).id).toBe('openai');
    });

    it('selects the OpenAI LLM provider when LLM_PROVIDER=openai (BYO OpenAI key)', () => {
      expect(
        loadLlmProvider({ ...OPTED_IN, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }).id,
      ).toBe('openai');
    });

    it('the opt-in NEVER weakens strict local mode (MUNIN_LOCAL_MODE wins)', () => {
      expect(() =>
        loadLlmProvider({
          ...OPTED_IN,
          MUNIN_LOCAL_MODE: 'true',
          LLM_PROVIDER: 'anthropic',
          ANTHROPIC_API_KEY: 'sk-x',
        }),
      ).toThrow(/MUNIN_LOCAL_MODE=true forbids/);
    });
  });

  it('a pure cloud stack is byte-for-byte unchanged (no posture inference engaged)', () => {
    expect(loadLlmProvider({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' }).id).toBe(
      'anthropic',
    );
    expect(loadEmbeddingProvider({ OPENAI_API_KEY: 'sk-x' }).id).toBe('openai');
    expect(
      loadLlmProvider({
        GRAPH_STORE: 'postgres',
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-x',
      }).id,
    ).toBe('anthropic');
  });
});

describe('MUNIN_DEV_MODE=haiku', () => {
  it('wraps the selected provider to report the Haiku default model', () => {
    const llm = loadLlmProvider({ LLM_PROVIDER: 'stub', MUNIN_DEV_MODE: 'haiku' });
    expect(llm.defaultModel).toBe(DEV_HAIKU_MODEL);
    expect(llm.id).toContain('forced');
  });

  it('routes the forced model into llm_calls telemetry (stub records it, region stays stub)', async () => {
    const llm = loadLlmProvider({ LLM_PROVIDER: 'stub', MUNIN_DEV_MODE: 'haiku' });
    const { ctx, calls } = fakeCallContext();
    await llm.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }, ctx);
    expect(calls[0]?.modelId).toBe(DEV_HAIKU_MODEL);
    expect(calls[0]?.region).toBe('stub');
  });

  it('forces the model on every request, overriding a per-call model', async () => {
    let seen: string | undefined;
    const recorder: LLMProvider = {
      id: 'recorder',
      capabilities: {
        promptCaching: false,
        asymmetricEmbeddings: false,
        maxInputTokens: 1,
        maxBatchSize: 1,
      },
      defaultModel: 'recorder-default',
      async complete(req) {
        seen = req.model;
        return {
          text: '',
          toolCalls: [],
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          modelId: req.model ?? 'none',
          stopReason: 'end_turn',
        };
      },
    };
    const wrapped = withForcedModel(recorder, DEV_HAIKU_MODEL);
    const { ctx } = fakeCallContext();
    const req: LLMRequest = { model: 'claude-opus-4-7', system: 's', messages: [] };
    await wrapped.complete(req, ctx);
    expect(seen).toBe(DEV_HAIKU_MODEL);
  });
});

describe('stub LLM provider behaviour', () => {
  it('returns an empty schema-valid extraction and records stub telemetry', async () => {
    const llm = loadLlmProvider({ LLM_PROVIDER: 'stub' });
    const { ctx, calls } = fakeCallContext();
    const res = await llm.complete(
      {
        system: 's',
        messages: [{ role: 'user', content: 'x' }],
        tools: [extractTool],
        toolChoice: { type: 'tool', name: 'extract' },
      },
      ctx,
    );
    expect(res.toolCalls[0]?.input).toEqual({ entities: [], relationships: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.region).toBe('stub');
  });

  it('echoes the first source as a grounded citation for the answer tool', async () => {
    const llm = loadLlmProvider({ LLM_PROVIDER: 'stub' });
    const { ctx } = fakeCallContext();
    const content = 'Question?\n<source id="P7">\nMarcus Webb leads the Atlas project.\n</source>';
    const res = await llm.complete(
      {
        system: 's',
        messages: [{ role: 'user', content }],
        tools: [answerTool],
        toolChoice: { type: 'tool', name: 'submit_answer' },
      },
      ctx,
    );
    const input = res.toolCalls[0]?.input as {
      status: string;
      citations: Array<{ sourceId: string; quote: string }>;
    };
    expect(input.status).toBe('answered');
    expect(input.citations[0]?.sourceId).toBe('P7');
    // The quote is verbatim from the source (passes hot-path quote-grounding).
    expect('Marcus Webb leads the Atlas project.').toContain(input.citations[0]?.quote ?? '');
  });

  // Lock down the citation-marker emission CONTRACT the web Ask path relies on:
  // (a) the rendered answer string contains a literal `[1]` marker so renderAnswer
  // can linkify it into a `Citation 1` button; (b) the citations array carries
  // `marker: 1` matching that text. Three E2E specs (3-citation, 4-happy-path,
  // 6-ask-deep) assert the resulting `aria-label="Citation 1"` button; this unit
  // pins the upstream invariant so a future stub-format change can't silently
  // un-render every UI assertion. Mirror under `marker:` in stub-providers.ts.
  it('emits a [1] marker in the answer text AND marker=1 in the citations array', async () => {
    const llm = loadLlmProvider({ LLM_PROVIDER: 'stub' });
    const { ctx } = fakeCallContext();
    const content = 'Question?\n<source id="P7">\nMarcus Webb leads the Atlas project.\n</source>';
    const res = await llm.complete(
      {
        system: 's',
        messages: [{ role: 'user', content }],
        tools: [answerTool],
        toolChoice: { type: 'tool', name: 'submit_answer' },
      },
      ctx,
    );
    const input = res.toolCalls[0]?.input as {
      status: string;
      answer: string;
      citations: Array<{ marker: number; sourceId: string; quote: string }>;
    };
    expect(input.status).toBe('answered');
    // (a) the answer text carries the [1] marker the renderer linkifies.
    expect(input.answer).toContain('[1]');
    // (b) the citations array entry uses marker=1 — so reconcileMarkers does
    // NOT drop it as an orphan, and the UI button gets `aria-label="Citation 1"`.
    expect(input.citations).toHaveLength(1);
    expect(input.citations[0]?.marker).toBe(1);
  });
});
