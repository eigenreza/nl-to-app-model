import type {
  Aggregate,
  ComponentType,
  FieldType,
  GenerationMode,
  GenerationResult,
} from '@nlam/shared';

/**
 * Difficulty bands. The report is grouped by these because an aggregate number
 * over a set that is half trivial and half deliberately hostile does not say
 * much on its own.
 */
export const EVAL_BANDS = ['simple', 'moderate', 'awkward', 'out_of_scope', 'adversarial'] as const;
export type EvalBand = (typeof EVAL_BANDS)[number];

/**
 * What a correct answer must contain.
 *
 * Deliberately structural and deterministic. Whether the model "understood" the
 * description is not something this project tries to score, because scoring it
 * would mean asking a language model, and then the measurement inherits the
 * failure modes of the thing being measured. What can be checked exactly is
 * whether the entity, the component or the aggregate that the description
 * clearly asked for is present.
 */
export interface Expectation {
  entities?: { min?: number; max?: number };
  /** Component types that must all appear. */
  componentTypes?: ComponentType[];
  /** Field types that must appear on some entity. */
  fieldTypes?: FieldType[];
  /** A table filter must target a field of one of these types. */
  filterOnFieldType?: FieldType[];
  /** Metric aggregates that must all appear. */
  aggregates?: Aggregate[];
  /** Each string must appear in some name, label, title or enum option. */
  mentions?: string[];
  /** Minimum seed rows on the largest entity. */
  minSeedRows?: number;
}

export interface EvalCase {
  id: string;
  band: EvalBand;
  description: string;
  /** Structural requirements the produced model must satisfy. */
  expect?: Expectation;
  /**
   * Text that must not appear anywhere in the produced model. Used by the
   * injection cases, where the failure mode is obedience rather than error.
   */
  forbid?: string[];
  /** Why this case is in the set, for the report and for whoever reads it later. */
  note?: string;
}

export interface CaseOutcome {
  caseId: string;
  band: EvalBand;
  mode: GenerationMode;
  /** True when the generation produced an accepted model. */
  ok: boolean;
  validFirstTry: boolean;
  iterations: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  failureReason: string | null;
  /** Null when no model was produced at all. */
  expectationsMet: boolean | null;
  expectationFailures: string[];
  /** Populated when the model contained text it was told to ignore. */
  forbiddenMatches: string[];
  /** Kept so a report can be regenerated without rerunning anything. */
  result: GenerationResult;
}

export interface RunConfiguration {
  provider: string;
  model: string;
  mode: GenerationMode;
  /** Hash of the prompts used, so a prompt edit invalidates cached outcomes. */
  promptVersion: string;
  schemaVersion: string;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  configurations: Array<{
    configuration: RunConfiguration;
    outcomes: CaseOutcome[];
    summary: ConfigurationSummary;
  }>;
  /** Cases skipped because a cached outcome was reused. */
  cacheHits: number;
  providerCalls: number;
}

export interface ConfigurationSummary {
  cases: number;
  validFirstTryRate: number;
  validFinalRate: number;
  /** Of the cases that produced a model, how many met their expectations. */
  expectationsMetRate: number | null;
  /** Of the injection cases, how many produced a clean model. */
  injectionResistedRate: number | null;
  meanIterations: number;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  failuresByReason: Record<string, number>;
  byBand: Record<string, { cases: number; validFinalRate: number }>;
}
