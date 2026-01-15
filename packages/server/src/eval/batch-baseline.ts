/**
 * The baseline eval, run through the batch endpoint.
 *
 * Baseline generation is one independent completion per fixture, which is
 * exactly the shape the batch endpoint is for, and it costs half as much. The
 * loop here is the same as the sequential generator's, turned inside out: every
 * fixture takes its first attempt together, they are all assessed, and only the
 * ones that failed validation go into the repair round.
 *
 * The agent loop deliberately does not come through here. Its turn two cannot
 * be written until turn one's tool results exist, so batching it would either
 * collapse into one-item batches or change what the loop does, and the loop is
 * the thing being measured.
 */
import { addUsage, emptyUsage, type GenerationResult, type ValidationIssue } from '@nlam/shared';
import { assessCandidate } from '../generation/baseline.js';
import { baselineSystemPrompt, baselineUserPrompt, repairUserPrompt } from '../generation/prompts.js';
import type { BatchItem, BatchOutcome, BatchRunner } from '../providers/batch.js';
import type { CompletionRequest, LLMMessage } from '../providers/types.js';
import type { EvalCase } from './types.js';

interface CaseState {
  evalCase: EvalCase;
  messages: LLMMessage[];
  steps: GenerationResult['steps'];
  usage: GenerationResult['usage'];
  iterations: number;
  validFirstTry: boolean;
  outstanding: ValidationIssue[];
  /** Set once the case is finished, successfully or not. */
  result: GenerationResult | null;
}

export interface BatchBaselineOptions {
  cases: readonly EvalCase[];
  runner: BatchRunner;
  providerName: string;
  modelName: string;
  /** Repair rounds after the first attempt. One, to match the sequential path. */
  maxRepairs?: number;
  onRound?: (info: { round: number; items: number }) => void;
}

export async function runBaselineBatch(
  options: BatchBaselineOptions,
): Promise<Map<string, GenerationResult>> {
  const maxRepairs = options.maxRepairs ?? 1;
  const startedAt = Date.now();

  const states = new Map<string, CaseState>();
  for (const evalCase of options.cases) {
    states.set(evalCase.id, {
      evalCase,
      messages: [{ role: 'user', content: baselineUserPrompt(evalCase.description) }],
      steps: [],
      usage: emptyUsage(),
      iterations: 0,
      validFirstTry: false,
      outstanding: [],
      result: null,
    });
  }

  const finish = (state: CaseState, overrides: Partial<GenerationResult>): void => {
    state.result = {
      ok: false,
      mode: 'baseline',
      provider: options.providerName,
      model: options.modelName,
      applicationModel: null,
      validFirstTry: state.validFirstTry,
      iterations: state.iterations,
      steps: state.steps,
      usage: state.usage,
      latencyMs: Date.now() - startedAt,
      failure: null,
      warnings: [],
      ...overrides,
    };
  };

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const pending = [...states.values()].filter((state) => state.result === null);
    if (pending.length === 0) break;

    const items: BatchItem[] = pending.map((state) => ({
      id: state.evalCase.id,
      request: {
        system: baselineSystemPrompt(),
        messages: state.messages,
        jsonMode: true,
        temperature: 0,
      } satisfies CompletionRequest,
    }));

    options.onRound?.({ round: attempt + 1, items: items.length });

    const outcomes = await options.runner.run(items);

    outcomes.forEach((outcome: BatchOutcome, index) => {
      const state = pending[index];
      if (!state) return;

      if (!outcome.ok) {
        state.steps.push({
          index: state.steps.length,
          kind: attempt === 0 ? 'draft' : 'repair',
          label: 'The provider call failed.',
          ok: false,
          detail: outcome.error.message,
          usage: emptyUsage(),
          latencyMs: 0,
        });
        finish(state, {
          failure: {
            reason: 'provider_error',
            message: outcome.error.message,
            outstandingIssues: state.outstanding,
          },
        });
        return;
      }

      const response = outcome.response;
      state.iterations += 1;
      state.usage = addUsage(state.usage, response.usage);

      const assessment = assessCandidate(response, attempt);
      state.steps.push({ ...assessment.step, index: state.steps.length });

      if (assessment.fatal) {
        finish(state, {
          failure: {
            reason: assessment.fatal.reason,
            message: assessment.fatal.message,
            outstandingIssues: state.outstanding,
          },
        });
        return;
      }

      if (assessment.model) {
        if (attempt === 0) state.validFirstTry = true;
        finish(state, {
          ok: true,
          applicationModel: assessment.model,
          validFirstTry: state.validFirstTry,
          warnings: assessment.warnings,
        });
        return;
      }

      state.outstanding = assessment.errors;

      if (attempt < maxRepairs) {
        state.messages = [
          ...state.messages,
          { role: 'assistant', content: response.text },
          { role: 'user', content: repairUserPrompt(assessment.errors) },
        ];
      }
    });
  }

  // Anything still unfinished used its repair budget without validating.
  for (const state of states.values()) {
    if (state.result) continue;
    finish(state, {
      failure: {
        reason: 'invalid_model',
        message: `Still invalid after ${maxRepairs === 1 ? 'one repair' : `${maxRepairs} repairs`}.`,
        outstandingIssues: state.outstanding,
      },
    });
  }

  const results = new Map<string, GenerationResult>();
  for (const [id, state] of states) {
    if (state.result) results.set(id, state.result);
  }
  return results;
}
