import { describe, expect, it, vi } from 'vitest';
import {
  retryDelayFrom,
  toGeminiContents,
  toProviderError as toGeminiError,
} from './gemini.js';
import {
  AnthropicProvider,
  toAnthropicMessages,
  toProviderError as toAnthropicError,
} from './anthropic.js';
import { estimateCostUsd, formatUsd, pricingFor } from './pricing.js';
import type { LLMMessage } from './types.js';

const conversation: LLMMessage[] = [
  { role: 'user', content: 'build a contact list' },
  {
    role: 'assistant',
    content: 'planning',
    toolCalls: [{ id: 'c1', name: 'plan', arguments: { text: 'one entity' } }],
  },
  { role: 'tool', toolCallId: 'c1', name: 'plan', content: 'ok' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'c2', name: 'create_entity', arguments: { id: 'contact' } },
      { id: 'c3', name: 'add_component', arguments: { id: 'table' } },
    ],
  },
  { role: 'tool', toolCallId: 'c2', name: 'create_entity', content: 'ok' },
  { role: 'tool', toolCallId: 'c3', name: 'add_component', content: 'ok' },
];

describe('gemini message mapping', () => {
  it('renames the assistant role and keeps tool calls as function calls', () => {
    const contents = toGeminiContents(conversation);

    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'build a contact list' }] });
    expect(contents[1]?.role).toBe('model');
    expect(contents[1]?.parts?.[0]).toEqual({ text: 'planning' });
    expect(contents[1]?.parts?.[1]?.functionCall?.name).toBe('plan');
  });

  it('folds consecutive tool results into one turn', () => {
    const contents = toGeminiContents(conversation);
    const last = contents.at(-1)!;

    expect(last.role).toBe('user');
    expect(last.parts).toHaveLength(2);
    expect(last.parts?.[0]?.functionResponse?.name).toBe('create_entity');
    expect(last.parts?.[1]?.functionResponse?.name).toBe('add_component');
  });

  it('drops an assistant turn that carries nothing at all', () => {
    const contents = toGeminiContents([{ role: 'assistant', content: '' }]);
    expect(contents).toEqual([]);
  });

  it('treats a connection failure as retryable and a refusal as permanent', () => {
    expect(toGeminiError(new TypeError('fetch failed')).retryable).toBe(true);
    expect(toGeminiError(new Error('unsupported model')).retryable).toBe(false);
  });

  it('reads the wait a rate limit response asked for', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' },
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
        ],
      },
    });

    expect(retryDelayFrom(body)).toBe(27_000);
    expect(retryDelayFrom('{"retryDelay": "1.5s"}')).toBe(1_500);
  });

  it('says nothing when there is no hint, and caps an absurd one', () => {
    expect(retryDelayFrom('plain failure')).toBeUndefined();
    expect(retryDelayFrom('{"retryDelay": "not-a-duration"}')).toBeUndefined();
    expect(retryDelayFrom('{"retryDelay": "9999s"}')).toBe(120_000);
  });
});

describe('anthropic message mapping', () => {
  it('emits tool_use blocks on the assistant turn', () => {
    const messages = toAnthropicMessages(conversation);

    expect(messages[1]?.role).toBe('assistant');
    const blocks = messages[1]?.content as Array<{ type: string; name?: string }>;
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]).toMatchObject({ type: 'tool_use', name: 'plan' });
  });

  it('merges consecutive tool results into one user turn', () => {
    const messages = toAnthropicMessages(conversation);
    const last = messages.at(-1)!;

    expect(last.role).toBe('user');
    expect(last.content).toHaveLength(2);
  });

  it('never produces two user turns in a row', () => {
    const messages = toAnthropicMessages(conversation);
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i]?.role).not.toBe(messages[i - 1]?.role);
    }
  });
});

/** Builds a fetch stand-in that answers with one canned Anthropic response. */
function stubFetch(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof globalThis.fetch;
}

describe('AnthropicProvider', () => {
  it('normalises a text and tool_use response', async () => {
    const fetch = stubFetch({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [
        { type: 'text', text: 'creating the entity' },
        { type: 'tool_use', id: 'tu_1', name: 'create_entity', input: { id: 'contact' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 120, output_tokens: 34 },
    });

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-haiku-4-5-20251001',
      fetch,
    });

    const response = await provider.complete({
      system: 'you build models',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        { name: 'create_entity', description: 'creates an entity', parameters: { type: 'object' } },
      ],
    });

    expect(response.text).toBe('creating the entity');
    expect(response.toolCalls).toEqual([
      { id: 'tu_1', name: 'create_entity', arguments: { id: 'contact' } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
    expect(response.finishReason).toBe('tool_use');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('turns a rate limit response into a retryable ProviderError', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-haiku-4-5-20251001',
      fetch: stubFetch(
        { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        429,
      ),
    });

    await expect(
      provider.complete({ system: '', messages: [{ role: 'user', content: 'go' }] }),
    ).rejects.toMatchObject({ name: 'ProviderError', status: 429, retryable: true });
  });

  it('refuses to start without a key', () => {
    expect(() => new AnthropicProvider({ apiKey: '', model: 'x' })).toThrow('ANTHROPIC_API_KEY');
  });

  it('classifies a bad request as permanent', () => {
    expect(toAnthropicError(new Error('unsupported parameter')).retryable).toBe(false);
  });
});

describe('pricing', () => {
  it('resolves a dated model id through its prefix', () => {
    expect(pricingFor('claude-haiku-4-5-20251001')).toEqual(pricingFor('claude-haiku-4-5'));
  });

  it('estimates a cost from token counts', () => {
    const cost = estimateCostUsd('gemini-2.5-flash', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(cost).toBeCloseTo(0.3 + 0.25);
  });

  it('says so rather than guessing when a model is unknown', () => {
    expect(estimateCostUsd('some-new-model', { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(formatUsd(null)).toBe('n/a');
  });
});
