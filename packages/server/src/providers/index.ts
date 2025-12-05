import { apiKeyFor, type Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { RateLimiter, ThrottledProvider, type Sleep } from './throttle.js';
import type { LLMProvider, ProviderError } from './types.js';

export * from './types.js';
export * from './throttle.js';
export * from './pricing.js';
export { GeminiProvider } from './gemini.js';
export { AnthropicProvider } from './anthropic.js';
export { ScriptedProvider, textTurn, toolTurn } from './scripted.js';

export interface CreateProviderOptions {
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
  sleep?: Sleep;
}

/**
 * Builds the configured provider and wraps it in the shared pacing and retry
 * layer. Called once at startup; the resulting object is reused for every
 * request so the rate limiter's state is process wide.
 */
export function createProvider(config: Config, options: CreateProviderOptions = {}): LLMProvider {
  const apiKey = apiKeyFor(config);

  const base: LLMProvider =
    config.LLM_PROVIDER === 'gemini'
      ? new GeminiProvider({
          apiKey,
          model: config.model,
          timeoutMs: config.LLM_TIMEOUT_MS,
        })
      : new AnthropicProvider({
          apiKey,
          model: config.model,
          timeoutMs: config.LLM_TIMEOUT_MS,
        });

  const limiter = new RateLimiter({
    requestsPerMinute: config.LLM_REQUESTS_PER_MINUTE,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  return new ThrottledProvider(base, {
    limiter,
    retry: {
      maxRetries: config.LLM_MAX_RETRIES,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    },
  });
}
