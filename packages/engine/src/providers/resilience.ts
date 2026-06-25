// Provider-call resilience: per-attempt timeout, bounded retry with exponential
// backoff, and bounded concurrency. Generic and SDK-FREE (no `@aws-sdk/*` import),
// so it composes with any provider's `send` and is exhaustively unit-testable with
// an injected fake. The Bedrock providers wrap every network call in
// `invokeWithResilience` so a stalled or transiently-failing call can never hang
// the process — it times out, retries, and surfaces a typed error on permanent
// failure.

import {
  AuthError,
  ContextLengthError,
  ProviderConfigurationError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitError,
} from './provider-errors';

export interface ResilienceOptions {
  readonly providerId: string;
  // Per-attempt timeout. A call that does not settle within this is aborted and
  // retried (the core anti-hang guarantee).
  readonly timeoutMs: number;
  // Total attempts including the first (so 4 = 1 try + 3 retries).
  readonly maxAttempts: number;
  // Exponential-backoff base (delay = baseDelayMs * 2^(attempt-1) + jitter).
  readonly baseDelayMs: number;
  // Injectable for fast, deterministic tests.
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

// Production defaults. 60s per attempt comfortably exceeds a healthy Titan/Claude
// call while bounding a stalled socket; 4 attempts over ~0.5s/1s/2s backoff
// recovers a transient blip without amplifying load.
export const DEFAULT_RESILIENCE = {
  timeoutMs: 60_000,
  maxAttempts: 4,
  baseDelayMs: 500,
} as const;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface AwsErrorLike {
  readonly name?: string;
  // Node system errors (socket / DNS / address failures) carry the code here —
  // NOT in `name` — so it must be inspected too (e.g. EADDRNOTAVAIL, ECONNRESET).
  readonly code?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

// Transient OS / socket / DNS errors (in `.code` or `.name`) — a stalled or
// dropped connection, address/port unavailability, or DNS flap over a long run.
// All recover on retry once the blip passes.
const TRANSIENT_NET =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EADDRNOTAVAIL|EADDRINUSE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|NetworkingError/i;

// Is this error worth retrying? Transient: our own timeout, rate-limit (429),
// service-unavailable (5xx), transient networking (socket/DNS/address blips), and
// transient auth flickers (ExpiredToken and the "authentication failed" blip seen
// on Bedrock). Not transient: a context-length or configuration error — retrying
// cannot help.
export function isRetryableBedrockError(err: unknown): boolean {
  if (err instanceof ProviderTimeoutError) return true;
  if (err instanceof ContextLengthError || err instanceof ProviderConfigurationError) return false;
  if (
    err instanceof RateLimitError ||
    err instanceof ProviderUnavailableError ||
    err instanceof AuthError
  ) {
    return true;
  }
  const e = (err ?? {}) as AwsErrorLike;
  const status = e.$metadata?.httpStatusCode ?? 0;
  const name = e.name ?? '';
  const code = e.code ?? '';
  if (status === 429 || status >= 500) return true;
  if (TRANSIENT_NET.test(code) || TRANSIENT_NET.test(name)) return true;
  if (
    /Throttl|TooManyRequests|ServiceQuota|ServiceUnavailable|InternalServer|Timeout|ModelNotReady|ModelTimeout/i.test(
      name,
    )
  ) {
    return true;
  }
  // Transient-auth retry (bounded by maxAttempts — a genuinely bad key still fails
  // fast-ish and surfaces AuthError).
  if (/ExpiredToken|UnrecognizedClient|AccessDenied|Unauthorized|Forbidden/i.test(name)) {
    return true;
  }
  return false;
}

/**
 * Run `send` with a per-attempt timeout and bounded exponential-backoff retry.
 * `send` receives an AbortSignal that fires on timeout (so a cooperating client
 * cancels the underlying socket); independently, the call is RACED against the
 * timeout so even a client that ignores the signal cannot hang. On a transient
 * failure it retries; on a permanent failure (or exhausted attempts) it throws
 * the last error (a typed ProviderError on timeout).
 */
export async function invokeWithResilience<O>(
  send: (options: { abortSignal: AbortSignal }) => Promise<O>,
  opts: ResilienceOptions,
): Promise<O> {
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<O>((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderTimeoutError(opts.providerId, opts.timeoutMs));
        }, opts.timeoutMs);
        const p = send({ abortSignal: controller.signal });
        p.then(resolve, reject);
        // Swallow a rejection that arrives AFTER we have already timed out (the
        // aborted in-flight request), so it cannot raise an unhandled rejection.
        p.catch(() => {});
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.maxAttempts || !isRetryableBedrockError(err)) throw err;
      const backoff = opts.baseDelayMs * 2 ** (attempt - 1);
      await sleep(backoff + backoff * 0.25 * random());
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw lastErr;
}

/**
 * Map over `items` with at most `limit` calls in flight, preserving input order.
 * If `fn` rejects, the returned promise rejects (callers that want per-item
 * tolerance make `fn` catch internally and return a result marker).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    let i = next++;
    while (i < items.length) {
      // reason: i is in [0, items.length) by the loop guard.
      // biome-ignore lint/style/noNonNullAssertion: index provably in-bounds
      results[i] = await fn(items[i]!, i);
      i = next++;
    }
  };
  const pool = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(pool);
  return results;
}
