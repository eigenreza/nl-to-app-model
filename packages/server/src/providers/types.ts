/**
 * The provider interface.
 *
 * Everything above this line in the stack (the baseline generator, the agent
 * loop, the eval runner) is written against these types and knows nothing about
 * any vendor. Two adapters implement it. The point is not that swapping vendors
 * is free, it is that the swap is confined to one file and that the agent logic
 * can be tested without a network at all.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Provider-assigned id, or a synthesised one for providers that omit it. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LLMMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface CompletionRequest {
  system: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  /** Ask the provider to emit a bare JSON object. Ignored when tools are given. */
  jsonMode?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** Provider-specific stop reason, normalised to lowercase. */
  finishReason: string;
  /** Wall-clock time for the call, including retries. */
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse>;
}

/**
 * Errors the retry layer understands. `retryable` decides whether the request
 * is worth another attempt, and `status` is carried through to logs.
 */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly provider: string;

  constructor(
    message: string,
    options: { provider: string; status?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
