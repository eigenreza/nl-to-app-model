/**
 * Configuration.
 *
 * Everything the server can be told is an environment variable, parsed once at
 * startup and validated with the same library the application model uses. A
 * missing or malformed value fails the process immediately with a readable
 * message rather than surfacing as a confusing failure on the first request.
 */
import { z } from 'zod';

const numberFromEnv = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

export const PROVIDER_NAMES = ['gemini', 'anthropic'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Model used when LLM_MODEL is not set, per provider. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-haiku-4-5-20251001',
};

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: numberFromEnv(8787, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default(''),

  LLM_PROVIDER: z.enum(PROVIDER_NAMES).default('gemini'),
  LLM_MODEL: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),

  /**
   * Outbound calls are throttled on the client side. The default sits well
   * below the free-tier allowance so that a burst of eval cases cannot walk
   * into a wall of 429 responses.
   */
  LLM_REQUESTS_PER_MINUTE: numberFromEnv(8, 1, 600),
  LLM_MAX_RETRIES: numberFromEnv(4, 0, 8),
  LLM_TIMEOUT_MS: numberFromEnv(60_000, 1_000, 300_000),

  AGENT_MAX_ITERATIONS: numberFromEnv(8, 1, 24),
  AGENT_TIME_BUDGET_MS: numberFromEnv(90_000, 5_000, 600_000),

  /**
   * "replay" serves precomputed traces and cannot reach a provider at all.
   * "live" allows generation, gated by DEMO_ACCESS_TOKEN when one is set.
   */
  DEMO_MODE: z.enum(['replay', 'live']).default('replay'),
  DEMO_ACCESS_TOKEN: z.string().default(''),

  RATE_LIMIT_MAX: numberFromEnv(20, 1, 10_000),
  RATE_LIMIT_WINDOW_MS: numberFromEnv(60_000, 1_000, 3_600_000),
  MAX_PROMPT_CHARS: numberFromEnv(2_000, 50, 20_000),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  /** LLM_MODEL when set, otherwise the default for the selected provider. */
  model: string;
  /** True when the process is allowed to call a provider at all. */
  liveGenerationEnabled: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }

  const env = parsed.data;
  const model = env.LLM_MODEL.trim() || DEFAULT_MODELS[env.LLM_PROVIDER];

  return {
    ...env,
    model,
    liveGenerationEnabled: env.DEMO_MODE === 'live',
  };
}

/** The credential for the selected provider, or an empty string when unset. */
export function apiKeyFor(config: Config): string {
  return config.LLM_PROVIDER === 'gemini' ? config.GEMINI_API_KEY : config.ANTHROPIC_API_KEY;
}
