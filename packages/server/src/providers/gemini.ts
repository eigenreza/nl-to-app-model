/**
 * Gemini adapter.
 *
 * The deployed configuration runs on a Flash-family model on the free tier, so
 * this adapter is the one that gets exercised. It translates the neutral
 * message list into Gemini's content format, asks for either JSON or function
 * calls, and normalises errors into ProviderError so the retry layer can decide
 * what is worth trying again.
 */
import { ApiError, GoogleGenAI, type Content, type Part } from '@google/genai';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type LLMMessage,
  type LLMProvider,
  type ToolCall,
} from './types.js';

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /**
   * Thinking token allowance for models that support it. Negative means "leave
   * the decision to the provider", which is the default; 0 turns thinking off,
   * which makes latency and token counts comparable across eval runs.
   */
  thinkingBudget?: number;
}

/** Status codes worth another attempt: rate limits, timeouts and server faults. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly options: GeminiProviderOptions;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) {
      throw new Error('GEMINI_API_KEY is required to use the Gemini provider.');
    }
    this.options = options;
    this.model = options.model;
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const startedAt = Date.now();

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: toGeminiContents(request.messages),
        config: {
          systemInstruction: request.system,
          temperature: request.temperature ?? 0,
          maxOutputTokens: request.maxOutputTokens ?? 8192,
          abortSignal: signal,
          ...(this.options.timeoutMs ? { httpOptions: { timeout: this.options.timeoutMs } } : {}),
          ...(this.options.thinkingBudget !== undefined && this.options.thinkingBudget >= 0
            ? { thinkingConfig: { thinkingBudget: this.options.thinkingBudget } }
            : {}),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      parametersJsonSchema: tool.parameters,
                    })),
                  },
                ],
              }
            : request.jsonMode
              ? { responseMimeType: 'application/json' }
              : {}),
        },
      });

      const usage = response.usageMetadata;
      const { text, toolCalls, providerState } = readParts(
        response.candidates?.[0]?.content?.parts ?? [],
      );

      return {
        text,
        toolCalls,
        ...(providerState ? { providerState } : {}),
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
        },
        finishReason: (response.candidates?.[0]?.finishReason ?? 'unknown')
          .toString()
          .toLowerCase(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

/**
 * Reads a response's parts directly rather than through the convenience
 * getters, for two reasons. Thinking summaries arrive as parts marked
 * `thought` and must not be replayed as assistant content. And the thinking
 * models attach a `thoughtSignature` to the parts they produce, which the API
 * requires back verbatim on the next turn: a conversation that drops it is
 * rejected outright, which is how this was found.
 */
export function readParts(parts: readonly Part[]): {
  text: string;
  toolCalls: ToolCall[];
  providerState: string | undefined;
} {
  let text = '';
  let providerState: string | undefined;
  const toolCalls: ToolCall[] = [];

  parts.forEach((part, index) => {
    if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id ?? `call_${index}`,
        name: part.functionCall.name ?? '',
        arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
        ...(part.thoughtSignature ? { providerState: part.thoughtSignature } : {}),
      });
      return;
    }

    if (part.thought) return; // A reasoning summary, not something to echo back.

    if (typeof part.text === 'string') {
      text += part.text;
      if (part.thoughtSignature) providerState = part.thoughtSignature;
    }
  });

  return { text, toolCalls, providerState };
}

/**
 * Gemini calls the assistant "model" and carries tool results as a user turn
 * holding functionResponse parts, so consecutive results have to be folded into
 * a single content entry.
 */
export function toGeminiContents(messages: readonly LLMMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: message.content }] });
      continue;
    }

    if (message.role === 'assistant') {
      const parts: Part[] = [];
      if (message.content) {
        parts.push({
          text: message.content,
          ...(message.providerState ? { thoughtSignature: message.providerState } : {}),
        });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: { id: call.id, name: call.name, args: call.arguments },
          ...(call.providerState ? { thoughtSignature: call.providerState } : {}),
        });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const part: Part = {
      functionResponse: {
        id: message.toolCallId,
        name: message.name,
        response: { result: message.content },
      },
    };

    const previous = contents[contents.length - 1];
    if (previous?.role === 'user' && previous.parts?.every((p) => p.functionResponse)) {
      previous.parts.push(part);
    } else {
      contents.push({ role: 'user', parts: [part] });
    }
  }

  return contents;
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  if (error instanceof ApiError) {
    return new ProviderError(
      `Gemini request failed with status ${error.status}: ${error.message}`,
      {
        provider: 'gemini',
        status: error.status,
        retryable: RETRYABLE_STATUS.has(error.status),
        cause: error,
      },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  // Undici surfaces connection problems as a plain TypeError, which is worth
  // retrying; anything else is treated as a permanent failure.
  const networkFailure = /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);

  return new ProviderError(`Gemini request failed: ${message}`, {
    provider: 'gemini',
    retryable: networkFailure,
    cause: error,
  });
}

/** Extracts a numeric HTTP status from a Gemini error, when there is one. */
export function statusOf(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}
