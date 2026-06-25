// MUNIN_REQUIRE_UK_RESIDENCY structural residency guard (G3-2).
//
// The managed-mode pilot rig sets this flag; these tests pin its contract:
// the factory must REFUSE — fail-fast, at construction, naming the provider —
// anything that is not UK-resident by construction. Permitted: bedrock pinned
// to eu-west-2 (London) or stub for LLM/embedding; none / llm-judge /
// loopback cross-encoder for reranking. Refused: anthropic + openai
// (US-hosted), ollama (not part of the managed posture), cohere-bedrock
// (eu-central-1/Frankfurt ONLY — audit P2-7), remote cross-encoder endpoints,
// and any explicit non-London Bedrock region.

import { afterAll, describe, expect, it } from 'vitest';

import { uninstallLocalModeEgressGuardForTests } from './local-egress-guard';
import { ProviderConfigurationError } from './provider-errors';
import {
  loadEmbeddingProvider,
  loadLlmProvider,
  loadProvidersFromEnv,
  loadRerankProvider,
} from './provider-factory';

// The composition tests below enable MUNIN_LOCAL_MODE, which installs the
// process-global egress dispatcher as a side effect; restore it afterwards.
afterAll(() => {
  uninstallLocalModeEgressGuardForTests();
});

const UK = { MUNIN_REQUIRE_UK_RESIDENCY: 'true' } as const;
// A valid Bedrock LLM env needs the Sonnet inference-profile id.
const BEDROCK_LLM = { LLM_PROVIDER: 'bedrock', BEDROCK_MODEL_SONNET: 'profile-sonnet' } as const;

describe('MUNIN_REQUIRE_UK_RESIDENCY — LLM provider', () => {
  it('REFUSES anthropic (US-hosted) — fail-fast naming the provider', () => {
    const env = { ...UK, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' };
    expect(() => loadLlmProvider(env)).toThrow(ProviderConfigurationError);
    expect(() => loadLlmProvider(env)).toThrow(/anthropic/);
    expect(() => loadLlmProvider(env)).toThrow(/MUNIN_REQUIRE_UK_RESIDENCY=true forbids/);
  });

  it('REFUSES the silent anthropic default when LLM_PROVIDER is unset', () => {
    // Residency mode must not fall back onto a US-hosted default.
    expect(() => loadLlmProvider({ ...UK, ANTHROPIC_API_KEY: 'sk-x' })).toThrow(
      ProviderConfigurationError,
    );
  });

  it('REFUSES ollama (not part of the managed posture)', () => {
    expect(() => loadLlmProvider({ ...UK, LLM_PROVIDER: 'ollama' })).toThrow(
      ProviderConfigurationError,
    );
  });

  it('ALLOWS bedrock with an explicit AWS_REGION=eu-west-2', () => {
    const llm = loadLlmProvider({ ...UK, ...BEDROCK_LLM, AWS_REGION: 'eu-west-2' });
    expect(llm.id).toBe('bedrock');
  });

  it('ALLOWS bedrock with AWS_REGION unset (the factory default IS eu-west-2 — structural)', () => {
    const llm = loadLlmProvider({ ...UK, ...BEDROCK_LLM });
    expect(llm.id).toBe('bedrock');
  });

  it('REFUSES bedrock pointed at any non-London region', () => {
    for (const region of ['us-east-1', 'eu-central-1', 'eu-west-1']) {
      const env = { ...UK, ...BEDROCK_LLM, AWS_REGION: region };
      expect(() => loadLlmProvider(env)).toThrow(ProviderConfigurationError);
      expect(() => loadLlmProvider(env)).toThrow(/violates UK residency/);
    }
  });

  it('ALLOWS stub (in-process, tests)', () => {
    expect(loadLlmProvider({ ...UK, LLM_PROVIDER: 'stub' }).id).toBe('stub-llm');
  });
});

describe('MUNIN_REQUIRE_UK_RESIDENCY — embedding provider', () => {
  it('REFUSES openai (US-hosted), including as the silent default', () => {
    expect(() =>
      loadEmbeddingProvider({ ...UK, EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }),
    ).toThrow(/openai/);
    expect(() => loadEmbeddingProvider({ ...UK, OPENAI_API_KEY: 'sk-x' })).toThrow(
      ProviderConfigurationError,
    );
  });

  it('REFUSES ollama', () => {
    expect(() => loadEmbeddingProvider({ ...UK, EMBEDDING_PROVIDER: 'ollama' })).toThrow(
      ProviderConfigurationError,
    );
  });

  it('ALLOWS bedrock at eu-west-2 (explicit or defaulted); REFUSES other regions', () => {
    expect(
      loadEmbeddingProvider({ ...UK, EMBEDDING_PROVIDER: 'bedrock', AWS_REGION: 'eu-west-2' }).id,
    ).toBe('bedrock');
    expect(loadEmbeddingProvider({ ...UK, EMBEDDING_PROVIDER: 'bedrock' }).id).toBe('bedrock');
    expect(() =>
      loadEmbeddingProvider({ ...UK, EMBEDDING_PROVIDER: 'bedrock', AWS_REGION: 'us-west-2' }),
    ).toThrow(/violates UK residency/);
  });

  it('ALLOWS stub (in-process, tests)', () => {
    expect(loadEmbeddingProvider({ ...UK, EMBEDDING_PROVIDER: 'stub' }).id).toBe('stub-embed');
  });
});

describe('MUNIN_REQUIRE_UK_RESIDENCY — reranker', () => {
  it('ALLOWS none (unset → none)', () => {
    expect(loadRerankProvider({ ...UK, ...BEDROCK_LLM })).toBeUndefined();
    expect(loadRerankProvider({ ...UK, ...BEDROCK_LLM, RERANK_PROVIDER: 'none' })).toBeUndefined();
  });

  it('REFUSES cohere-bedrock ALWAYS — Frankfurt-only, even with AWS_REGION=eu-west-2 (P2-7)', () => {
    const env = { ...UK, RERANK_PROVIDER: 'cohere-bedrock', AWS_REGION: 'eu-west-2' };
    expect(() => loadRerankProvider(env)).toThrow(ProviderConfigurationError);
    expect(() => loadRerankProvider(env)).toThrow(/eu-central-1 \(Frankfurt\)/);
  });

  it('ALLOWS llm-judge over a residency-checked LLM (bedrock eu-west-2, or stub)', () => {
    expect(loadRerankProvider({ ...UK, ...BEDROCK_LLM, RERANK_PROVIDER: 'llm-judge' })?.id).toBe(
      'llm-judge',
    );
    expect(
      loadRerankProvider({ ...UK, LLM_PROVIDER: 'stub', RERANK_PROVIDER: 'llm-judge' })?.id,
    ).toBe('llm-judge');
  });

  it('llm-judge cannot smuggle a US judge: its LLM construction hits the same guard', () => {
    // The judge LLM is built via the residency-checked selector — an anthropic
    // LLM_PROVIDER refuses even though the rerank id itself is permitted.
    expect(() =>
      loadRerankProvider({
        ...UK,
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-x',
        RERANK_PROVIDER: 'llm-judge',
      }),
    ).toThrow(/anthropic/);
  });

  it('ALLOWS the cross-encoder only against a loopback endpoint', () => {
    for (const endpoint of [
      'http://localhost:8080/rerank',
      'http://127.0.0.1:9000/rerank',
      'http://[::1]:8080/rerank',
    ]) {
      const rerank = loadRerankProvider({
        ...UK,
        ...BEDROCK_LLM,
        RERANK_PROVIDER: 'cross-encoder',
        RERANK_ENDPOINT: endpoint,
      });
      expect(rerank?.id).toBe('cross-encoder');
    }
    // Default endpoint is loopback too.
    expect(
      loadRerankProvider({ ...UK, ...BEDROCK_LLM, RERANK_PROVIDER: 'cross-encoder' })?.id,
    ).toBe('cross-encoder');
  });

  it('REFUSES a remote cross-encoder endpoint (residency not structurally verifiable)', () => {
    expect(() =>
      loadRerankProvider({
        ...UK,
        RERANK_PROVIDER: 'cross-encoder',
        RERANK_ENDPOINT: 'http://rerank.example.com/rerank',
      }),
    ).toThrow(ProviderConfigurationError);
  });
});

describe('MUNIN_REQUIRE_UK_RESIDENCY — bundle + composition', () => {
  it('the full pilot-rig bundle constructs: bedrock LLM + bedrock embeddings, eu-west-2', () => {
    const bundle = loadProvidersFromEnv({
      ...UK,
      ...BEDROCK_LLM,
      EMBEDDING_PROVIDER: 'bedrock',
      AWS_REGION: 'eu-west-2',
    });
    expect(bundle.llm.id).toBe('bedrock');
    expect(bundle.embedding.id).toBe('bedrock');
    expect(bundle.rerank).toBeUndefined();
  });

  it('no bypass via the bundle entry point', () => {
    expect(() =>
      loadProvidersFromEnv({ ...UK, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' }),
    ).toThrow(ProviderConfigurationError);
  });

  it('does NOT constrain provider choice when the flag is unset/false', () => {
    expect(loadLlmProvider({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' }).id).toBe(
      'anthropic',
    );
    expect(
      loadLlmProvider({
        MUNIN_REQUIRE_UK_RESIDENCY: 'false',
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-x',
      }).id,
    ).toBe('anthropic');
  });

  it('COMPOSES with MUNIN_LOCAL_MODE — neither weakens the other; only stub passes both', () => {
    // Local mode refuses bedrock (egress) even though residency permits it.
    expect(() => loadLlmProvider({ ...UK, ...BEDROCK_LLM, MUNIN_LOCAL_MODE: 'true' })).toThrow(
      /MUNIN_LOCAL_MODE=true forbids/,
    );
    // Residency refuses ollama even though local mode permits it.
    expect(() =>
      loadLlmProvider({ ...UK, LLM_PROVIDER: 'ollama', MUNIN_LOCAL_MODE: 'true' }),
    ).toThrow(/MUNIN_REQUIRE_UK_RESIDENCY=true forbids/);
    // The stub satisfies both.
    expect(loadLlmProvider({ ...UK, LLM_PROVIDER: 'stub', MUNIN_LOCAL_MODE: 'true' }).id).toBe(
      'stub-llm',
    );
  });

  it('MUNIN_ALLOW_CLOUD_PROVIDERS=true does NOT weaken the residency guard', () => {
    // The BYO-key egress acknowledgement is a different posture entirely — it
    // must never re-admit a US-hosted provider under the residency flag.
    expect(() =>
      loadLlmProvider({
        ...UK,
        MUNIN_ALLOW_CLOUD_PROVIDERS: 'true',
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-x',
      }),
    ).toThrow(/MUNIN_REQUIRE_UK_RESIDENCY=true forbids/);
  });

  it('is an ALLOWLIST: an unknown/future provider id refuses under residency mode', () => {
    expect(() => loadLlmProvider({ ...UK, LLM_PROVIDER: 'shiny-new-eu-api' })).toThrow(
      /MUNIN_REQUIRE_UK_RESIDENCY=true forbids/,
    );
    expect(() => loadEmbeddingProvider({ ...UK, EMBEDDING_PROVIDER: 'shiny-new-eu-api' })).toThrow(
      /MUNIN_REQUIRE_UK_RESIDENCY=true forbids/,
    );
  });
});

describe('MUNIN_REQUIRE_UK_RESIDENCY — flag parsing is fail-fast', () => {
  it("enables on 'true' with whitespace/case variance (no fail-open on ' TRUE ')", () => {
    expect(() =>
      loadLlmProvider({
        MUNIN_REQUIRE_UK_RESIDENCY: ' TRUE ',
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-x',
      }),
    ).toThrow(/MUNIN_REQUIRE_UK_RESIDENCY=true forbids/);
  });

  it('THROWS on any unrecognised non-empty value — a typo must not silently disable the guard', () => {
    for (const bad of ['1', 'yes', 'ture', 'on']) {
      expect(() =>
        loadLlmProvider({
          MUNIN_REQUIRE_UK_RESIDENCY: bad,
          LLM_PROVIDER: 'anthropic',
          ANTHROPIC_API_KEY: 'sk-x',
        }),
      ).toThrow(/not a recognised value/);
    }
  });
});

describe('MUNIN_REQUIRE_UK_RESIDENCY — Bedrock structural pins beyond the region', () => {
  it('REFUSES geographic cross-region inference profiles (eu./us./apac.) — EU-resident is not UK-resident', () => {
    for (const profile of [
      'eu.anthropic.claude-sonnet-4-6-v1:0',
      'us.anthropic.claude-sonnet-4-6-v1:0',
      'apac.anthropic.claude-sonnet-4-6-v1:0',
    ]) {
      expect(() =>
        loadLlmProvider({ ...UK, LLM_PROVIDER: 'bedrock', BEDROCK_MODEL_SONNET: profile }),
      ).toThrow(/geographic cross-region inference profile/);
    }
  });

  it('REFUSES the ARN form of a geographic profile too', () => {
    expect(() =>
      loadLlmProvider({
        ...UK,
        LLM_PROVIDER: 'bedrock',
        BEDROCK_MODEL_SONNET:
          'arn:aws:bedrock:eu-west-2:123456789012:inference-profile/eu.anthropic.claude-sonnet-4-6-v1:0',
      }),
    ).toThrow(/geographic cross-region inference profile/);
  });

  it('checks EVERY configured model var, not just the default family', () => {
    expect(() =>
      loadLlmProvider({
        ...UK,
        ...BEDROCK_LLM, // bare sonnet id — fine on its own
        BEDROCK_MODEL_HAIKU: 'eu.anthropic.claude-haiku-4-5-v1:0',
      }),
    ).toThrow(/BEDROCK_MODEL_HAIKU/);
  });

  it('ALLOWS single-region vendor-prefixed ids (anthropic. / amazon. are vendors, not geographies)', () => {
    expect(
      loadLlmProvider({
        ...UK,
        LLM_PROVIDER: 'bedrock',
        BEDROCK_MODEL_SONNET: 'anthropic.claude-sonnet-4-6-v1:0',
      }).id,
    ).toBe('bedrock');
    expect(
      loadEmbeddingProvider({
        ...UK,
        EMBEDDING_PROVIDER: 'bedrock',
        BEDROCK_EMBED_MODEL: 'amazon.titan-embed-text-v2:0',
      }).id,
    ).toBe('bedrock');
  });

  it('REFUSES a geographic profile on the embedding model var as well', () => {
    expect(() =>
      loadEmbeddingProvider({
        ...UK,
        EMBEDDING_PROVIDER: 'bedrock',
        BEDROCK_EMBED_MODEL: 'eu.amazon.titan-embed-text-v2:0',
      }),
    ).toThrow(/geographic cross-region inference profile/);
  });

  it('REFUSES AWS SDK endpoint overrides — they redirect traffic while AWS_REGION still reads eu-west-2', () => {
    expect(() =>
      loadLlmProvider({ ...UK, ...BEDROCK_LLM, AWS_ENDPOINT_URL: 'https://evil.example.com' }),
    ).toThrow(/AWS_ENDPOINT_URL/);
    expect(() =>
      loadLlmProvider({
        ...UK,
        ...BEDROCK_LLM,
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      }),
    ).toThrow(/AWS_ENDPOINT_URL_BEDROCK_RUNTIME/);
  });
});
