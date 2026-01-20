import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { BatchRunner, type BatchItem } from './batch.js';

/**
 * Stands in for the batches resource. The runner never touches a network in
 * these tests: it is driven entirely by the statuses and results scripted here.
 */
function fakeClient(options: {
  statuses: Array<'in_progress' | 'ended'>;
  results: Array<{ custom_id: string; result: unknown }>;
  onCreate?: (body: unknown) => void;
}) {
  let call = 0;

  const batches = {
    create: vi.fn(async (body: unknown) => {
      options.onCreate?.(body);
      return { id: 'batch_1', processing_status: options.statuses[0] ?? 'ended' };
    }),
    retrieve: vi.fn(async () => {
      call += 1;
      return { id: 'batch_1', processing_status: options.statuses[call] ?? 'ended' };
    }),
    results: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const entry of options.results) yield entry;
      },
    })),
  };

  return { messages: { batches } } as unknown as Anthropic;
}

function message(text: string): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

const items: BatchItem[] = [
  { id: 'first', request: { system: 's', messages: [{ role: 'user', content: 'a' }] } },
  { id: 'second', request: { system: 's', messages: [{ role: 'user', content: 'b' }] } },
];

function runner(client: Anthropic, overrides: Record<string, unknown> = {}) {
  return new BatchRunner({
    apiKey: 'test',
    model: 'claude-haiku-4-5-20251001',
    client,
    sleep: async () => {},
    ...overrides,
  });
}

describe('BatchRunner', () => {
  it('submits one request per item and returns answers in the order given', async () => {
    let submitted: unknown;
    const client = fakeClient({
      statuses: ['ended'],
      onCreate: (body) => {
        submitted = body;
      },
      // Deliberately out of order, to prove results are matched by id.
      results: [
        { custom_id: 'item_1', result: { type: 'succeeded', message: message('second answer') } },
        { custom_id: 'item_0', result: { type: 'succeeded', message: message('first answer') } },
      ],
    });

    const outcomes = await runner(client).run(items);

    const requests = (submitted as { requests: Array<{ custom_id: string }> }).requests;
    expect(requests.map((r) => r.custom_id)).toEqual(['item_0', 'item_1']);

    expect(outcomes.map((o) => o.id)).toEqual(['first', 'second']);
    expect(outcomes[0]?.ok && outcomes[0].response.text).toBe('first answer');
    expect(outcomes[1]?.ok && outcomes[1].response.text).toBe('second answer');
  });

  it('polls until the batch has ended', async () => {
    const client = fakeClient({
      statuses: ['in_progress', 'in_progress', 'ended'],
      results: [
        { custom_id: 'item_0', result: { type: 'succeeded', message: message('a') } },
        { custom_id: 'item_1', result: { type: 'succeeded', message: message('b') } },
      ],
    });

    const seen: string[] = [];
    const outcomes = await runner(client, {
      onProgress: ({ status }: { status: string }) => seen.push(status),
    }).run(items);

    expect(seen).toEqual(['in_progress', 'in_progress']);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it('carries token counts through, including cached ones', async () => {
    const client = fakeClient({
      statuses: ['ended'],
      results: [
        {
          custom_id: 'item_0',
          result: {
            type: 'succeeded',
            message: {
              ...(message('a') as Record<string, unknown>),
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                cache_read_input_tokens: 500,
                cache_creation_input_tokens: 0,
              },
            },
          },
        },
      ],
    });

    const outcomes = await runner(client).run([items[0]!]);
    expect(outcomes[0]?.ok && outcomes[0].response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 500,
    });
  });

  it('reports a failed item without failing its neighbours', async () => {
    const client = fakeClient({
      statuses: ['ended'],
      results: [
        { custom_id: 'item_0', result: { type: 'succeeded', message: message('fine') } },
        {
          custom_id: 'item_1',
          result: { type: 'errored', error: { type: 'invalid_request_error' } },
        },
      ],
    });

    const outcomes = await runner(client).run(items);

    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]?.ok).toBe(false);
    expect(!outcomes[1]?.ok && outcomes[1]?.error.message).toContain('errored');
  });

  it('reports an item the batch simply did not answer', async () => {
    const client = fakeClient({
      statuses: ['ended'],
      results: [{ custom_id: 'item_0', result: { type: 'succeeded', message: message('fine') } }],
    });

    const outcomes = await runner(client).run(items);

    expect(outcomes[1]?.ok).toBe(false);
    expect(!outcomes[1]?.ok && outcomes[1]?.error.message).toContain('no result');
  });

  it('gives up waiting rather than hanging forever', async () => {
    let clock = 0;
    // A batch that never ends, however many times it is polled.
    const client = fakeClient({
      statuses: Array.from({ length: 50 }, () => 'in_progress' as const),
      results: [],
    });

    await expect(
      runner(client, {
        maxWaitMs: 1_000,
        now: () => {
          clock += 600;
          return clock;
        },
      }).run(items),
    ).rejects.toThrow(/still in_progress/);
  });

  it('does nothing at all for an empty list', async () => {
    const client = fakeClient({ statuses: ['ended'], results: [] });
    await expect(runner(client).run([])).resolves.toEqual([]);
    expect(client.messages.batches.create).not.toHaveBeenCalled();
  });
});
