import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_MODELS, type GenerateResponse, type GenerationEvent } from '@nlam/shared';
import { ApiError, streamGeneration } from './client.js';

function response(events: GenerationEvent[], chunkAt?: number): Response {
  const text = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  const bytes = new TextEncoder().encode(text);

  // Splitting mid-object is the case that breaks a naive line reader, so tests
  // can force it.
  const chunks =
    chunkAt === undefined ? [bytes] : [bytes.slice(0, chunkAt), bytes.slice(chunkAt)];

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function result(overrides: Partial<GenerateResponse> = {}): GenerateResponse {
  return {
    requestId: 'req-1',
    source: 'replay',
    estimatedCostUsd: 0,
    ok: true,
    mode: 'agent',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    applicationModel: EXAMPLE_MODELS.contact_list,
    validFirstTry: true,
    iterations: 5,
    steps: [],
    usage: { inputTokens: 100, outputTokens: 20 },
    latencyMs: 1200,
    failure: null,
    warnings: [],
    ...overrides,
  };
}

const step = (index: number, label: string): GenerationEvent => ({
  type: 'step',
  step: {
    index,
    kind: 'tool',
    label,
    ok: true,
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 100,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamGeneration', () => {
  it('reports each step and resolves with the final result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response([
          { type: 'accepted', requestId: 'req-1', mode: 'agent', source: 'replay' },
          step(0, 'Planned the application.'),
          step(1, 'Created entity "contact".'),
          { type: 'result', result: result() },
        ]),
      ),
    );

    const seen: string[] = [];
    const finished = await streamGeneration({
      description: 'a contact list',
      mode: 'agent',
      onStep: (received) => seen.push(received.label),
    });

    expect(seen).toEqual(['Planned the application.', 'Created entity "contact".']);
    expect(finished.applicationModel?.app.name).toBe('Contact list');
  });

  it('reassembles an event split across chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response([step(0, 'Planned the application.'), { type: 'result', result: result() }], 30)),
    );

    const seen: string[] = [];
    const finished = await streamGeneration({
      description: 'a contact list',
      mode: 'agent',
      onStep: (received) => seen.push(received.label),
    });

    expect(seen).toEqual(['Planned the application.']);
    expect(finished.requestId).toBe('req-1');
  });

  it('throws the reason carried by an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response([
          { type: 'accepted', requestId: 'r', mode: 'agent', source: 'replay' },
          { type: 'error', code: 'replay_miss', message: 'No recorded trace for that.' },
        ]),
      ),
    );

    await expect(
      streamGeneration({ description: 'x y z', mode: 'agent', onStep: () => {} }),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'replay_miss' });
  });

  it('surfaces a failure that happened before the stream opened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many.' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(
      streamGeneration({ description: 'x y z', mode: 'agent', onStep: () => {} }),
    ).rejects.toMatchObject({ code: 'rate_limited', message: 'Too many.' });
  });

  it('complains when the stream ends without a result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response([step(0, 'Planned the application.')])),
    );

    await expect(
      streamGeneration({ description: 'x y z', mode: 'agent', onStep: () => {} }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('sends the access token only when one was supplied', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response([{ type: 'result', result: result() }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const headersOfCall = (index: number): Record<string, string> =>
      (fetchMock.mock.calls[index]?.[1]?.headers ?? {}) as Record<string, string>;

    await streamGeneration({ description: 'x y z', mode: 'agent', onStep: () => {} });
    expect(headersOfCall(0)['x-demo-token']).toBeUndefined();

    await streamGeneration({
      description: 'x y z',
      mode: 'agent',
      accessToken: 'letmein',
      onStep: () => {},
    });
    expect(headersOfCall(1)['x-demo-token']).toBe('letmein');
  });
});
