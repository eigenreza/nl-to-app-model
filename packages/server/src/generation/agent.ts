/**
 * The agent loop.
 *
 * The model does not write the document. It calls tools, the server applies
 * them to a draft it owns, and every call comes back either confirmed or
 * rejected with the specific reason. Errors therefore arrive while the mistake
 * is still local and cheap to fix, instead of arriving as a wall of paths after
 * a whole document has been written.
 *
 * The loop is bounded twice, by iteration count and by wall-clock time, and
 * neither bound is allowed to produce nothing. Whatever the reason for
 * stopping, the draft is salvaged into the best model that still validates and
 * returned alongside a structured report of what did not work.
 */
import { summariseIssues, type ValidationIssue } from '@nlam/shared';
import {
  ProviderError,
  addUsage,
  emptyUsage,
  type LLMMessage,
  type LLMProvider,
  type TokenUsage,
} from '../providers/types.js';
import { ModelDraft } from './draft.js';
import { agentNudgePrompt, agentSystemPrompt, agentUserPrompt } from './prompts.js';
import { executeTool, toolDefinitions } from './tools.js';
import type { FailureReason, GenerationResult, GenerationStep, StepKind } from './types.js';

export interface AgentOptions {
  description: string;
  provider: LLMProvider;
  maxIterations?: number;
  timeBudgetMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onStep?: (step: GenerationStep) => void;
}

/** Replies with no tool call are tolerated twice before the attempt is abandoned. */
const MAX_NUDGES = 2;

export async function generateWithAgent(options: AgentOptions): Promise<GenerationResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const maxIterations = options.maxIterations ?? 8;
  const timeBudgetMs = options.timeBudgetMs ?? 90_000;

  const draft = new ModelDraft();
  const tools = toolDefinitions();
  const system = agentSystemPrompt();
  const messages: LLMMessage[] = [{ role: 'user', content: agentUserPrompt(options.description) }];

  const steps: GenerationStep[] = [];
  let usage: TokenUsage = emptyUsage();
  let iterations = 0;
  let nudges = 0;
  let anyRejection = false;

  const record = (step: Omit<GenerationStep, 'index'>) => {
    const full = { ...step, index: steps.length };
    steps.push(full);
    options.onStep?.(full);
  };

  const settle = (failure: { reason: FailureReason; message: string } | null): GenerationResult => {
    const validation = draft.validate();

    if (failure === null && validation.ok && validation.model) {
      return {
        ok: true,
        mode: 'agent',
        provider: options.provider.name,
        model: options.provider.model,
        applicationModel: validation.model,
        validFirstTry: !anyRejection,
        iterations,
        steps,
        usage,
        latencyMs: now() - startedAt,
        failure: null,
        warnings: validation.warnings,
      };
    }

    const salvaged = draft.salvage();
    const removedNote =
      salvaged.removed.length > 0
        ? ` Returning a partial model with ${salvaged.removed.join(', ')} removed.`
        : salvaged.model
          ? ' Returning the model as it stood.'
          : ' Nothing valid could be salvaged.';

    return {
      ok: false,
      mode: 'agent',
      provider: options.provider.name,
      model: options.provider.model,
      applicationModel: salvaged.model,
      validFirstTry: false,
      iterations,
      steps,
      usage,
      latencyMs: now() - startedAt,
      failure: {
        reason: failure?.reason ?? 'invalid_model',
        message: `${failure?.message ?? `The model was never finalized: ${summariseIssues(validation.issues)}.`}${removedNote}`,
        outstandingIssues: validation.errors,
      },
      warnings: salvaged.model ? validation.warnings : [],
    };
  };

  for (iterations = 0; iterations < maxIterations;) {
    if (now() - startedAt > timeBudgetMs) {
      record({
        kind: 'finalize',
        ok: false,
        label: 'Stopped: out of time.',
        usage: emptyUsage(),
        latencyMs: 0,
      });
      return settle({
        reason: 'time_budget',
        message: `Stopped after ${iterations} ${iterations === 1 ? 'iteration' : 'iterations'} because the time budget ran out.`,
      });
    }

    let response;
    try {
      response = await options.provider.complete(
        { system, messages, tools, temperature: 0 },
        options.signal,
      );
    } catch (error) {
      const message =
        error instanceof ProviderError || error instanceof Error ? error.message : String(error);
      record({
        kind: 'tool',
        ok: false,
        label: 'The provider call failed.',
        detail: message,
        usage: emptyUsage(),
        latencyMs: 0,
      });
      return settle({ reason: 'provider_error', message });
    }

    iterations += 1;
    usage = addUsage(usage, response.usage);

    if (response.toolCalls.length === 0) {
      nudges += 1;
      record({
        kind: 'tool',
        ok: false,
        label: 'Replied without calling a tool.',
        ...(response.text.trim() ? { detail: response.text.trim().slice(0, 400) } : {}),
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      if (nudges > MAX_NUDGES) {
        return settle({
          reason: 'invalid_model',
          message: `The provider stopped calling tools after ${iterations} iterations.`,
        });
      }

      messages.push({ role: 'assistant', content: response.text || '(no content)' });
      messages.push({ role: 'user', content: agentNudgePrompt() });
      continue;
    }

    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    let finished = false;
    let firstOfTurn = true;

    for (const call of response.toolCalls) {
      const execution = executeTool(draft, call);
      if (!execution.ok) anyRejection = true;

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: execution.content,
      });

      record({
        kind: stepKindFor(call.name),
        ok: execution.ok,
        label: execution.label,
        ...(execution.issues.length > 0 ? { issues: execution.issues } : {}),
        // Token cost belongs to the turn, not to each call within it.
        usage: firstOfTurn ? response.usage : emptyUsage(),
        latencyMs: firstOfTurn ? response.latencyMs : 0,
      });

      firstOfTurn = false;
      if (execution.finished) finished = true;
    }

    if (finished) return settle(null);
  }

  return settle({
    reason: 'iteration_cap',
    message: `Stopped after the maximum of ${maxIterations} iterations without a finalized model.`,
  });
}

function stepKindFor(toolName: string): StepKind {
  if (toolName === 'plan') return 'plan';
  if (toolName === 'finalize') return 'finalize';
  return 'tool';
}

/** Re-exported so callers can report the taxonomy without importing internals. */
export type { ValidationIssue };
