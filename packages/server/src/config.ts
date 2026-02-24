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
  gemini: 'gemini-3.6-flash',
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
  LLM_REQUESTS_PER_MINUTE: numberFromEnv(4, 1, 600),
  LLM_MAX_RETRIES: numberFromEnv(6, 0, 12),
  LLM_TIMEOUT_MS: numberFromEnv(60_000, 1_000, 300_000),

  /**
   * Hard ceiling on what a single process may spend, in USD. Enforced from the
   * token counts the provider reports, not merely estimated beforehand. Zero
   * means no ceiling, which is the right default for a free tier.
   */
  LLM_SPEND_CAP_USD: z.coerce.number().min(0).max(1000).default(0),
  /** Cache the static system and tool prefix between calls, where supported. */
  LLM_PROMPT_CACHING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  AGENT_MAX_ITERATIONS: numberFromEnv(12, 1, 24),
  /**
   * Budget for time spent inside provider calls, not wall clock. Wall clock
   * would also count the spacing the rate limiter deliberately applies, so a
   * tighter throttle would shorten the budget, which is backwards.
   */
  AGENT_TIME_BUDGET_MS: numberFromEnv(120_000, 5_000, 600_000),

  /**
   * "replay" serves recorded traces and cannot reach a provider at all.
   * "live" serves recorded traces too, and generates for anything else, inside
   * the daily budget below. A recorded prompt never spends budget, so the
   * sample prompts keep working after the allowance for the day is gone.
   */
  DEMO_MODE: z.enum(['replay', 'live']).default('replay'),
  DEMO_ACCESS_TOKEN: z.string().default(''),

  /**
   * Ceiling on live generation spend for one UTC day, in USD, computed from the
   * token counts the provider reports and held on disk so that a restart does
   * not hand out a fresh allowance. Reaching it disables live generation until
   * the day turns. Replay is unaffected.
   */
  DAILY_SPEND_CAP_USD: z.coerce.number().min(0).max(1000).default(0.3),
  /**
   * Held back so a generation is only started with room to finish. An agent
   * generation measured about $0.023 on the eval, so the default leaves room
   * for roughly two.
   */
  LIVE_RESERVE_USD: z.coerce.number().min(0).max(100).default(0.05),
  /** Live generations one address may start per UTC day. */
  LIVE_PER_IP_PER_DAY: numberFromEnv(3, 1, 1000),
  /** Live generations in flight at once, across everyone. */
  LIVE_MAX_CONCURRENT: numberFromEnv(1, 1, 16),
  /**
   * Where the daily ledger is written. Defaults to a path inside the repository.
   * On a deployment this must point at storage that survives a restart, or the
   * budget resets every time the process does.
   */
  BUDGET_STATE_PATH: z.string().default(''),

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
