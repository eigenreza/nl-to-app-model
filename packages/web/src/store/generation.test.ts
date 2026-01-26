import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_MODELS, type GenerateResponse, type GenerationEvent } from '@nlam/shared';
import { createAppStore } from './index.js';
import { descriptionChanged, generate, loadDeploymentInfo, modeChanged } from './generationSlice.js';

function ndjson(events: GenerationEvent[]): Response {
  const text = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const generated: GenerateResponse = {
  requestId: 'req-1',
  source: 'replay',
  estimatedCostUsd: 0,
  ok: true,
  mode: 'agent',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  applicationModel: EXAMPLE_MODELS.expense_log,
  validFirstTry: true,
  iterations: 6,
  steps: [],
  usage: { inputTokens: 3000, outputTokens: 400 },
  latencyMs: 4200,
  failure: null,
  warnings: [],
};

const stepEvent = (index: number, label: string, ok = true): GenerationEvent => ({
  type: 'step',
  step: {
    index,
    kind: 'tool',
    label,
    ok,
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 50,
  },
});

/** Routes stubbed fetch calls by path so a test can describe a whole deployment. */
function stubApi(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const route = Object.entries(routes).find(([path]) => url.includes(path));
      if (!route) throw new Error(`No stub for ${url}`);
      return route[1]();
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deployment info', () => {
  it('records what the server says it can do', async () => {
    stubApi({
      '/api/health': () =>
        json({
          status: 'ok',
          demoMode: 'replay',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          schemaVersion: '1.0.0',
          replayTraces: 2,
          liveGenerationEnabled: false,
        }),
      '/api/catalogue': () =>
        json({ entries: [{ id: 'books', description: 'a book tracker', mode: 'agent' }] }),
    });

    const store = createAppStore();
    await store.dispatch(loadDeploymentInfo());

    const state = store.getState().generation;
    expect(state.health?.liveGenerationEnabled).toBe(false);
    expect(state.catalogue).toHaveLength(1);
  });
});

describe('generate', () => {
  it('collects the trace and applies the produced model', async () => {
    stubApi({
      '/api/generate/stream': () =>
        ndjson([
          { type: 'accepted', requestId: 'req-1', mode: 'agent', source: 'replay' },
          stepEvent(0, 'Planned the application.'),
          stepEvent(1, 'Component "unread" rejected.', false),
          stepEvent(2, 'Accepted the model.'),
          { type: 'result', result: generated },
        ]),
    });

    const store = createAppStore();
    store.dispatch(descriptionChanged('an expense log'));
    await store.dispatch(generate());

    const state = store.getState();
    expect(state.generation.status).toBe('succeeded');
    expect(state.generation.steps.map((step) => step.label)).toEqual([
      'Planned the application.',
      'Component "unread" rejected.',
      'Accepted the model.',
    ]);
    expect(state.generation.summary).toMatchObject({ iterations: 6, source: 'replay' });

    // The rendered application follows from the model slice, not from this one.
    expect(state.model.model?.app.name).toBe('Expense log');
    expect(state.model.source).toBe('generated');
    expect(state.runtime.data.expense).toHaveLength(5);
  });

  it('renders a partial model and reports why the run failed', async () => {
    stubApi({
      '/api/generate/stream': () =>
        ndjson([
          stepEvent(0, 'Planned the application.'),
          {
            type: 'result',
            result: {
              ...generated,
              ok: false,
              applicationModel: EXAMPLE_MODELS.contact_list,
              failure: {
                reason: 'iteration_cap',
                message: 'Stopped after the maximum of 8 iterations.',
                outstandingIssues: [],
              },
            },
          },
        ]),
    });

    const store = createAppStore();
    store.dispatch(descriptionChanged('something difficult'));
    await store.dispatch(generate());

    const state = store.getState();
    expect(state.generation.status).toBe('failed');
    expect(state.generation.failure?.reason).toBe('iteration_cap');
    expect(state.model.model?.app.name).toBe('Contact list');
  });

  it('reports a server refusal without touching the model on screen', async () => {
    stubApi({
      '/api/generate/stream': () =>
        json({ error: { code: 'replay_miss', message: 'No recorded trace for that.' } }, 409),
    });

    const store = createAppStore();
    const before = store.getState().model.model?.app.name;
    store.dispatch(descriptionChanged('a spaceship maintenance log'));
    await store.dispatch(generate());

    const state = store.getState();
    expect(state.generation.status).toBe('failed');
    expect(state.generation.error).toEqual({
      code: 'replay_miss',
      message: 'No recorded trace for that.',
    });
    expect(state.model.model?.app.name).toBe(before);
  });

  it('clears the previous trace when a new run starts', async () => {
    stubApi({
      '/api/generate/stream': () =>
        ndjson([stepEvent(0, 'Planned the application.'), { type: 'result', result: generated }]),
    });

    const store = createAppStore();
    store.dispatch(descriptionChanged('an expense log'));
    await store.dispatch(generate());
    expect(store.getState().generation.steps).toHaveLength(1);

    await store.dispatch(generate());
    expect(store.getState().generation.steps).toHaveLength(1);
  });

  it('sends the mode the user selected', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ndjson([{ type: 'result', result: generated }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const store = createAppStore();
    store.dispatch(descriptionChanged('an expense log'));
    store.dispatch(modeChanged('baseline'));
    await store.dispatch(generate());

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ description: 'an expense log', mode: 'baseline' });
  });
});

describe('an unreachable server', () => {
  it('is recorded rather than passed over in silence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const store = createAppStore();
    await store.dispatch(loadDeploymentInfo());

    expect(store.getState().generation.unreachable).toBe(true);
    expect(store.getState().generation.health).toBeNull();
  });

  it('clears once the server answers again', async () => {
    const store = createAppStore();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await store.dispatch(loadDeploymentInfo());
    expect(store.getState().generation.unreachable).toBe(true);

    vi.unstubAllGlobals();
    stubApi({
      '/api/health': () =>
        json({
          status: 'ok',
          demoMode: 'replay',
          provider: 'gemini',
          model: 'gemini-3.6-flash',
          schemaVersion: '1.0.0',
          replayTraces: 0,
          liveGenerationEnabled: false,
        }),
      '/api/catalogue': () => json({ entries: [] }),
    });
    await store.dispatch(loadDeploymentInfo());

    expect(store.getState().generation.unreachable).toBe(false);
    expect(store.getState().generation.health?.status).toBe('ok');
  });
});
