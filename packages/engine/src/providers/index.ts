// Public exports for the provider layer.

export type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  LLMToolChoice,
  ProviderBundle,
  ProviderCallContext,
  ProviderCapabilities,
  RerankDocument,
  RerankProvider,
  RerankRequest,
  RerankResponse,
  RerankResult,
} from './provider-types';

export {
  AuthError,
  ContextLengthError,
  ProviderConfigurationError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitError,
} from './provider-errors';

export { AnthropicLLMProvider } from './anthropic-llm-provider';
export { OpenAILLMProvider } from './openai-llm-provider';
export { OpenAIEmbeddingProvider } from './openai-embedding-provider';
export { BedrockLLMProvider } from './bedrock-llm-provider';
export { BedrockTitanEmbeddingProvider } from './bedrock-titan-embedding-provider';
export { BedrockCohereRerankProvider } from './bedrock-cohere-rerank-provider';
export { LlmJudgeRerankProvider } from './llm-judge-rerank-provider';
export { OllamaLLMProvider } from './ollama-llm-provider';
export { OllamaEmbeddingProvider } from './ollama-embedding-provider';
export { StubLLMProvider, StubEmbeddingProvider } from './stub-providers';
export { DEV_HAIKU_MODEL, withForcedModel } from './dev-model-override';
export {
  loadProvidersFromEnv,
  loadLlmProvider,
  loadEmbeddingProvider,
  loadRerankProvider,
} from './provider-factory';
