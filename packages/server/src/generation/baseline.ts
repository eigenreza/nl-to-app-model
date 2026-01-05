/**
 * The baseline generator: ask once, validate, allow one repair.
 *
 * This is the control the agent loop is measured against. It exists so the
 * eval report can answer the only question that matters about the extra
 * machinery, which is whether it buys anything. Keeping it in the codebase
 * rather than deleting it after the first measurement also means the comparison
 * can be re-run whenever the schema or the prompts change.
 */
import {
  summariseIssues,
  validateApplicationModel,
  withSchemaVersion,
  type ValidationIssue,
} from '@nlam/shared';
import { addUsage, emptyUsage, type TokenUsage } from '@nlam/shared';
import {
  ProviderError,
  type CompletionResponse,
  type LLMMessage,
  type LLMProvider,
} from '../providers/types.js';
import { extractJsonObject } from './json.js';
import { baselineSystemPrompt, baselineUserPrompt, repairUserPrompt } from './prompts.js';
import type { FailureReason, GenerationResult, GenerationStep } from './types.js';

export interface BaselineOptions {
  description: string;
  provider: LLMProvider;
  /** Repair turns allowed after the first attempt. One by definition. */
  maxRepairs?: number;
  timeBudgetMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onStep?: (step: GenerationStep) => void;
}

export async function generateBaseline(options: BaselineOptions): Promise<GenerationResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const maxRepairs = options.maxRepairs ?? 1;

  const steps: GenerationStep[] = [];
  let usage: TokenUsage = emptyUsage();
  let iterations = 0;
  let validFirstTry = false;

  const messages: LLMMessage[] = [
    { role: 'user', content: baselineUserPrompt(options.description) },
  ];

  const record = (step: GenerationStep) => {
    steps.push(step);
    options.onStep?.(step);
  };

  const finish = (
    applicationModel: GenerationResult['applicationModel'],
    warnings: ValidationIssue[],
    failure: GenerationResult['failure'],
  ): GenerationResult => ({
    ok: failure === null && applicationModel !== null,
    mode: 'baseline',
    provider: options.provider.name,
    model: options.provider.model,
    applicationModel,
    validFirstTry,
    iterations,
    steps,
    usage,
    latencyMs: now() - startedAt,
    failure,
    warnings,
  });

  const fail = (reason: FailureReason, message: string, outstanding: ValidationIssue[] = []) =>
    finish(null, [], { reason, message, outstandingIssues: outstanding });

  let lastIssues: ValidationIssue[] = [];

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    if (options.timeBudgetMs && now() - startedAt > options.timeBudgetMs) {
      return fail('time_budget', 'Ran out of time before a valid model was produced.', lastIssues);
    }

    let response: CompletionResponse;
    try {
      response = await options.provider.complete(
        {
          system: baselineSystemPrompt(),
          messages,
          jsonMode: true,
          temperature: 0,
        },
        options.signal,
      );
    } catch (error) {
      const message =
        error instanceof ProviderError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      record({
        index: steps.length,
        kind: attempt === 0 ? 'draft' : 'repair',
        label: 'The provider call failed.',
        ok: false,
        detail: message,
        usage: emptyUsage(),
        latencyMs: 0,
      });
      return fail('provider_error', message, lastIssues);
    }

    iterations += 1;
    usage = addUsage(usage, response.usage);

    const kind = attempt === 0 ? 'draft' : 'repair';
    const extraction = extractJsonObject(response.text);

    if (!extraction.ok) {
      const detail =
        response.text.trim() === ''
          ? 'The provider returned no text.'
          : `Could not read a JSON object from the response: ${extraction.error}`;
      record({
        index: steps.length,
        kind,
        label: 'The response was not usable JSON.',
        ok: false,
        detail,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });
      return fail(
        response.text.trim() === '' ? 'empty_output' : 'unparseable_output',
        detail,
        lastIssues,
      );
    }

    const validation = validateApplicationModel(withSchemaVersion(extraction.value));

    record({
      index: steps.length,
      kind,
      label: validation.ok
        ? attempt === 0
          ? 'Produced a valid model on the first attempt.'
          : 'Repair produced a valid model.'
        : `Candidate rejected: ${summariseIssues(validation.issues)}.`,
      ok: validation.ok,
      ...(extraction.recovered ? { detail: 'JSON was recovered from surrounding text.' } : {}),
      issues: validation.issues,
      usage: response.usage,
      latencyMs: response.latencyMs,
    });

    if (validation.ok && validation.model) {
      if (attempt === 0) validFirstTry = true;
      return finish(validation.model, validation.warnings, null);
    }

    lastIssues = validation.errors;

    if (attempt < maxRepairs) {
      messages.push({
        role: 'assistant',
        content: response.text,
        ...(response.providerState ? { providerState: response.providerState } : {}),
      });
      messages.push({ role: 'user', content: repairUserPrompt(validation.errors) });
    }
  }

  return fail(
    'invalid_model',
    `Still invalid after ${maxRepairs === 1 ? 'one repair' : `${maxRepairs} repairs`}: ${summariseIssues(lastIssues)}.`,
    lastIssues,
  );
}
