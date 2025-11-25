import type { ApplicationModel, ValidationIssue } from '@nlam/shared';
import type { TokenUsage } from '../providers/types.js';

export type GenerationMode = 'baseline' | 'agent';

export type StepKind = 'draft' | 'repair' | 'plan' | 'tool' | 'finalize';

/**
 * One entry in the trace. The trace is not a debug log: it is shown in the
 * browser while a generation runs, stored as a replay fixture, and summarised
 * by the eval harness, so it has to be structured rather than free text.
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
 * count. A generation that fails still returns the best model it reached, so a
 * failure report accompanies a partial result rather than replacing it.
 */
export interface FailureReport {
  reason: FailureReason;
  message: string;
  /** Issues still outstanding when the attempt was abandoned. */
  outstandingIssues: ValidationIssue[];
}

export interface GenerationResult {
  ok: boolean;
  mode: GenerationMode;
  provider: string;
  model: string;
  /** The accepted model, or the best partial one when the attempt failed. */
  applicationModel: ApplicationModel | null;
  /** True when the first candidate validated without any repair. */
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
