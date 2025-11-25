/**
 * Anthropic adapter.
 *
 * The deployed configuration runs on Gemini. This adapter exists because a
 * provider abstraction that has only ever had one implementation is not an
 * abstraction, it is a guess. Writing the second one is what proves the
 * interface carries everything the agent loop needs: a system prompt, an
 * alternating message list, tool definitions, tool results and token counts.
 *
 * It is exercised through an injected fetch implementation in the test suite,
 * which is also how the retry and message-mapping behaviour is verified without
 * a network.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type LLMMessage,
  type LLMProvider,
} from './types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  baseURL?: string;
  /** Injected in tests so the adapter can be driven without a network. */
  fetch?: typeof globalThis.fetch;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

type AnthropicMessage = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlockParam;

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required to use the Anthropic provider.');
    }
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      // Retries are handled one layer up, together with the rate limiter, so
      // that both providers behave identically under pressure.
      maxRetries: 0,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const startedAt = Date.now();

    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens ?? 8192,
          temperature: request.temperature ?? 0,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
        },
        signal ? { signal } : undefined,
      );

      let text = '';
      const toolCalls: CompletionResponse['toolCalls'] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }

      return {
        text,
        toolCalls,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        finishReason: (response.stop_reason ?? 'unknown').toLowerCase(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

/**
 * Collapses the neutral message list into Anthropic's alternating format. Tool
 * results become content blocks on a user turn and consecutive results are
 * merged, because the API rejects two user turns in a row.
 */
export function toAnthropicMessages(messages: readonly LLMMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    const block: ContentBlock = {
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: message.content,
    };

    const previous = out[out.length - 1];
    if (previous?.role === 'user' && Array.isArray(previous.content)) {
      previous.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }

  return out;
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    return new ProviderError(
      `Anthropic request failed with status ${status ?? 'unknown'}: ${error.message}`,
      {
        provider: 'anthropic',
        ...(status === undefined ? {} : { status }),
        retryable: status === undefined ? true : RETRYABLE_STATUS.has(status),
        cause: error,
      },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const networkFailure = /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);

  return new ProviderError(`Anthropic request failed: ${message}`, {
    provider: 'anthropic',
    retryable: networkFailure,
    cause: error,
  });
}
