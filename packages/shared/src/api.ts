/**
 * The contract between the server and the browser.
 *
 * The trace types live here rather than in the server package because the
 * browser renders the trace while a generation runs, and a duplicated interface
 * on the client is the kind of thing that drifts quietly until a field is
 * silently undefined. One definition, imported by both.
 */
import type { ApplicationModel } from './model.js';
import type { ValidationIssue } from './issues.js';

/**
 * Token counts for one call.
 *
 * Cached tokens are counted separately rather than folded into the input total,
 * because they are billed at different rates: a write costs more than an
 * ordinary input token and a read costs a fraction of one. Adding them together
 * would make the cost column wrong in whichever direction the cache was working.
 */
export interface TokenUsage {
  /** Input tokens billed at the ordinary rate, excluding anything cached. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens written into the provider's prompt cache, billed at a premium. */
  cacheWriteTokens?: number;
  /** Tokens served from the provider's prompt cache, billed at a discount. */
  cacheReadTokens?: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  const cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);

  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  };
}

/** Every input token a call consumed, whatever rate it was billed at. */
export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0);
}

export type GenerationMode = 'baseline' | 'agent';

export type StepKind = 'draft' | 'repair' | 'plan' | 'tool' | 'finalize';

/**
 * One entry in the trace. Not a debug log: it is rendered in the browser while
 * a generation runs, stored as a replay fixture and summarised by the eval
 * harness, so it is structured rather than free text.
 */
export interface GenerationStep {
  index: number;
  kind: StepKind;
  /** Short human-readable summary, safe to render. */
  label: string;
  ok: boolean;
  detail?: string;
  issues?: ValidationIssue[];
  usage: TokenUsage;
  latencyMs: number;
}

export type FailureReason =
  | 'iteration_cap'
  | 'time_budget'
  | 'unparseable_output'
  | 'invalid_model'
  | 'provider_error'
  | 'empty_output';

/**
 * What went wrong, in a shape the browser can render and the eval harness can
 * count. A failed generation still returns the best model it reached, so this
 * accompanies a partial result rather than replacing it.
 */
export interface FailureReport {
  reason: FailureReason;
  message: string;
  outstandingIssues: ValidationIssue[];
}

export interface GenerationResult {
  ok: boolean;
  mode: GenerationMode;
  provider: string;
  model: string;
  /** The accepted model, or the best partial one when the attempt failed. */
  applicationModel: ApplicationModel | null;
  /** True when the first complete candidate was accepted with no repair. */
  validFirstTry: boolean;
  /** Provider calls made. The cost driver, so it is reported on its own. */
  iterations: number;
  steps: GenerationStep[];
  usage: TokenUsage;
  latencyMs: number;
  failure: FailureReport | null;
  /** Warnings on the accepted model. Never block acceptance. */
  warnings: ValidationIssue[];
}

/* -------------------------------------------------------------------------- */
/* HTTP envelopes                                                             */
/* -------------------------------------------------------------------------- */

export interface GenerateRequest {
  description: string;
  mode?: GenerationMode;
}

export interface GenerateResponse extends GenerationResult {
  requestId: string;
  /** Whether this came from a provider call or from a recorded trace. */
  source: 'live' | 'replay';
  /** List price for the tokens used, or null when the model is not priced. */
  estimatedCostUsd: number | null;
}

/** Streamed as newline-delimited JSON while a generation runs. */
export type GenerationEvent =
  | { type: 'accepted'; requestId: string; mode: GenerationMode; source: 'live' | 'replay' }
  | { type: 'step'; step: GenerationStep }
  | { type: 'result'; result: GenerateResponse }
  | { type: 'error'; code: string; message: string };

export interface HealthResponse {
  status: 'ok';
  demoMode: 'replay' | 'live';
  provider: string;
  model: string;
  schemaVersion: string;
  replayTraces: number;
  /** True when this process is able to call a provider at all. */
  liveGenerationEnabled: boolean;
}

export interface CatalogueEntry {
  id: string;
  description: string;
  mode: GenerationMode;
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}
