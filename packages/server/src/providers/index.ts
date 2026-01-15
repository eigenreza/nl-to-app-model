import { apiKeyFor, type Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { BudgetedProvider, SpendGuard } from './budget.js';
import { RateLimiter, ThrottledProvider, type Sleep } from './throttle.js';
import type { LLMProvider, ProviderError } from './types.js';
import type { TokenUsage } from '@nlam/shared';

export * from './types.js';
export * from './throttle.js';
export * from './pricing.js';
export * from './budget.js';
export * from './batch.js';
export { GeminiProvider } from './gemini.js';
export { AnthropicProvider } from './anthropic.js';
export { ScriptedProvider, textTurn, toolTurn } from './scripted.js';

export interface CreateProviderOptions {
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
  onSpend?: (info: { spentUsd: number; capUsd: number; usage: TokenUsage }) => void;
  sleep?: Sleep;
}

export interface CreatedProvider {
  provider: LLMProvider;
  /** Present only when a spend cap is configured. */
  guard: SpendGuard | undefined;
}

/**
 * Builds the configured provider and wraps it in the shared layers: pacing and
 * retries always, and a spend guard when a ceiling is configured.
 *
 * The order matters. The guard is outermost so that a retry cannot spend past
 * the cap, and so that the tokens a retried call consumed are still counted.
 */
export function createProviderWithGuard(
  config: Config,
  options: CreateProviderOptions = {},
): CreatedProvider {
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
          promptCaching: config.LLM_PROMPT_CACHING,
        });

  const limiter = new RateLimiter({
    requestsPerMinute: config.LLM_REQUESTS_PER_MINUTE,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  const throttled = new ThrottledProvider(base, {
    limiter,
    retry: {
      maxRetries: config.LLM_MAX_RETRIES,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    },
  });

  if (config.LLM_SPEND_CAP_USD <= 0) {
    return { provider: throttled, guard: undefined };
  }

  const guard = new SpendGuard({
    capUsd: config.LLM_SPEND_CAP_USD,
    model: config.model,
    ...(options.onSpend ? { onSpend: options.onSpend } : {}),
  });

  return { provider: new BudgetedProvider(throttled, guard), guard };
}

/** Convenience for callers that do not need the guard handle. */
export function createProvider(config: Config, options: CreateProviderOptions = {}): LLMProvider {
  return createProviderWithGuard(config, options).provider;
}
