/**
 * A provider that returns whatever the test told it to return.
 *
 * The agent loop is the interesting part of this project and it needs to be
 * testable without a network, without a key and without spending anything. This
 * adapter makes the whole loop deterministic: a test writes the sequence of
 * model turns it wants and then asserts on what the loop did with them.
 */
import { emptyUsage } from '@nlam/shared';
import type { CompletionRequest, CompletionResponse, LLMProvider } from './types.js';

export type ScriptedTurn =
  | Partial<CompletionResponse>
  | Error
  | ((request: CompletionRequest, index: number) => Partial<CompletionResponse> | Error);

export interface ScriptedProviderOptions {
  name?: string;
  model?: string;
  /** Returned once the script runs out. Defaults to an empty text response. */
  fallback?: Partial<CompletionResponse>;
}

export class ScriptedProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  /** Every request the loop made, in order. Tests assert on these. */
  readonly requests: CompletionRequest[] = [];

  private index = 0;

  constructor(
    private readonly turns: readonly ScriptedTurn[],
    private readonly options: ScriptedProviderOptions = {},
  ) {
    this.name = options.name ?? 'scripted';
    this.model = options.model ?? 'scripted-model';
  }

  get callCount(): number {
    return this.index;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(request));
    const turn = this.turns[this.index];
    this.index += 1;

    const resolved =
      typeof turn === 'function' ? turn(request, this.index - 1) : (turn ?? this.options.fallback);

    if (resolved instanceof Error) throw resolved;

    return {
      text: '',
      toolCalls: [],
      usage: emptyUsage(),
      finishReason: 'stop',
      latencyMs: 0,
      ...(resolved ?? {}),
    };
  }
}

/** Convenience for a plain text turn. */
export function textTurn(text: string, usage = { inputTokens: 100, outputTokens: 50 }) {
  return { text, usage } satisfies Partial<CompletionResponse>;
}

/** Convenience for a turn that calls one tool. */
export function toolTurn(
  name: string,
  args: Record<string, unknown>,
  options: { id?: string; text?: string } = {},
) {
  return {
    text: options.text ?? '',
    toolCalls: [{ id: options.id ?? `call_${name}`, name, arguments: args }],
    usage: { inputTokens: 100, outputTokens: 50 },
  } satisfies Partial<CompletionResponse>;
}
