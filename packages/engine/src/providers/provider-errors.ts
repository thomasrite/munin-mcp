// Typed errors for the provider layer. Implementations map their
// provider-specific errors into one of these so callers see a uniform
// surface.

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`[${providerId}] ${message}`);
    this.name = 'ProviderError';
  }
}

export class RateLimitError extends ProviderError {
  constructor(
    providerId: string,
    public readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(
      providerId,
      `rate limited${retryAfterMs ? ` (retry after ${retryAfterMs}ms)` : ''}`,
      cause,
    );
    this.name = 'RateLimitError';
  }
}

export class AuthError extends ProviderError {
  constructor(providerId: string, cause?: unknown) {
    super(providerId, 'authentication failed — check API key', cause);
    this.name = 'AuthError';
  }
}

export class ContextLengthError extends ProviderError {
  constructor(
    providerId: string,
    public readonly inputTokens: number,
    public readonly maxTokens: number,
    cause?: unknown,
  ) {
    super(providerId, `input exceeds context window (${inputTokens} > ${maxTokens})`, cause);
    this.name = 'ContextLengthError';
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(providerId: string, cause?: unknown) {
    super(providerId, 'provider unavailable or unreachable', cause);
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderConfigurationError extends ProviderError {
  constructor(providerId: string, message: string) {
    super(providerId, `configuration error: ${message}`);
    this.name = 'ProviderConfigurationError';
  }
}

// A request exceeded its per-attempt timeout (a stalled socket / unresponsive
// model). Surfaced after retries are exhausted so a hung call can never block
// indefinitely. Treated as transient (retryable).
export class ProviderTimeoutError extends ProviderError {
  constructor(
    providerId: string,
    public readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(providerId, `request timed out after ${timeoutMs}ms`, cause);
    this.name = 'ProviderTimeoutError';
  }
}
