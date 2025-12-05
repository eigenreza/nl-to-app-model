/**
 * One entry point for producing a generation, whichever mode is asked for and
 * whichever source can answer it.
 *
 * The routes and the recorder both go through here so that the rule about when
 * a provider may be called lives in exactly one place. In replay mode there is
 * no provider object at all, which makes an accidental live call a type error
 * rather than a billing surprise.
 */
import type { GenerationMode, GenerationResult, GenerationStep } from '@nlam/shared';
import type { LLMProvider } from '../providers/types.js';
import type { ReplayStore } from '../replay/store.js';
import { generateBaseline } from './baseline.js';
import { generateWithAgent } from './agent.js';

export class ReplayMissError extends Error {
  readonly available: string[];

  constructor(available: string[]) {
    super('This deployment is in replay mode and has no recorded trace for that description.');
    this.name = 'ReplayMissError';
    this.available = available;
  }
}

export class LiveDisabledError extends Error {
  constructor() {
    super('Live generation is not enabled on this deployment.');
    this.name = 'LiveDisabledError';
  }
}

export interface RunOptions {
  description: string;
  mode: GenerationMode;
  maxIterations: number;
  timeBudgetMs: number;
  signal?: AbortSignal;
  onStep?: (step: GenerationStep) => void;
}

export interface RunOutcome {
  result: GenerationResult;
  source: 'live' | 'replay';
}

/** Answers from a recorded trace. Never touches a provider. */
export function runFromReplay(store: ReplayStore, options: RunOptions): RunOutcome {
  const trace = store.find(options.description, options.mode);
  if (!trace) {
    throw new ReplayMissError(store.catalogue().map((entry) => entry.description));
  }

  // Replaying the trace step by step keeps the browser's progress view
  // identical to a live run, which is the point of recording the whole trace
  // rather than only the finished model.
  for (const step of trace.result.steps) options.onStep?.(step);

  return { result: trace.result, source: 'replay' };
}

/** Calls the provider. Only reachable when live generation is enabled. */
export async function runLive(provider: LLMProvider, options: RunOptions): Promise<RunOutcome> {
  const result =
    options.mode === 'agent'
      ? await generateWithAgent({
          description: options.description,
          provider,
          maxIterations: options.maxIterations,
          timeBudgetMs: options.timeBudgetMs,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onStep ? { onStep: options.onStep } : {}),
        })
      : await generateBaseline({
          description: options.description,
          provider,
          timeBudgetMs: options.timeBudgetMs,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onStep ? { onStep: options.onStep } : {}),
        });

  return { result, source: 'live' };
}
