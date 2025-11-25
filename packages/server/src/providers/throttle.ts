/**
 * Client-side pacing and retries.
 *
 * Free-tier quotas are the binding constraint on this project, so the throttle
 * is not a reaction to rejection, it is the default posture: requests are
 * spaced out before they are sent, and only genuine transient failures are
 * retried. Both the clock and the sleep function are injectable so the
 * behaviour can be tested without waiting in real time.
 */
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type LLMProvider,
} from './types.js';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted while waiting for the rate limiter.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface RateLimiterOptions {
  requestsPerMinute: number;
  now?: () => number;
  sleep?: Sleep;
}

/**
 * Spaces request starts evenly. One call in flight at a time is intentional:
 * the free tier is measured in requests per minute, and an evenly spaced
 * sequence is far less likely to trip it than a burst followed by a pause.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private nextSlotAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.intervalMs = Math.ceil(60_000 / Math.max(1, options.requestsPerMinute));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
  }

  /** Resolves when the caller may start its request. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const wait = this.chain.then(async () => {
      const now = this.now();
      const startAt = Math.max(now, this.nextSlotAt);
      this.nextSlotAt = startAt + this.intervalMs;
      const delay = startAt - now;
      if (delay > 0) await this.sleep(delay, signal);
    });
    // Failures must not poison the queue for later callers.
    this.chain = wait.then(
      () => undefined,
      () => undefined,
    );
    return wait;
  }
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: Sleep;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

/** Exponential backoff with full jitter, applied only to retryable failures. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
  signal?: AbortSignal,
): Promise<T> {
  const base = options.baseDelayMs ?? 1_000;
  const cap = options.maxDelayMs ?? 20_000;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(error instanceof Error ? error.message : String(error), {
              provider: 'unknown',
              cause: error,
            });

      if (!providerError.retryable || attempt >= options.maxRetries || signal?.aborted) {
        throw providerError;
      }

      const ceiling = Math.min(cap, base * 2 ** attempt);
      const delayMs = Math.round(ceiling * (0.5 + random() * 0.5));
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: providerError });
      await sleep(delayMs, signal);
      attempt += 1;
    }
  }
}

export interface ThrottledProviderOptions {
  limiter: RateLimiter;
  retry: Omit<RetryOptions, 'sleep'> & { sleep?: Sleep };
}

/**
 * Wraps a provider so that every call is paced and retried. Keeping this
 * separate from the adapters means the vendor code stays small and the pacing
 * rules are identical whichever vendor is selected.
 */
export class ThrottledProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly options: ThrottledProviderOptions,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    return withRetry(
      async () => {
        await this.options.limiter.acquire(signal);
        return this.inner.complete(request, signal);
      },
      this.options.retry,
      signal,
    );
  }
}
