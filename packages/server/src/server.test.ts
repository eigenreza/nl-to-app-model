import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { EXAMPLE_MODELS, type GenerationEvent, type GenerationResult } from '@nlam/shared';
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { ReplayStore, type ReplayTrace } from './replay/store.js';
import { ScriptedProvider, toolTurn } from './providers/scripted.js';
import { buildServer } from './server.js';
import type { ServerContext } from './context.js';

const silentLogger = pino({ level: 'silent' });

function recordedResult(): GenerationResult {
  return {
    ok: true,
    mode: 'agent',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    applicationModel: EXAMPLE_MODELS.contact_list,
    validFirstTry: true,
    iterations: 5,
    steps: [
      {
        index: 0,
        kind: 'plan',
        label: 'Planned the application.',
        ok: true,
        usage: { inputTokens: 900, outputTokens: 60 },
        latencyMs: 800,
      },
      {
        index: 1,
        kind: 'finalize',
        label: 'Accepted the model.',
        ok: true,
        usage: { inputTokens: 1200, outputTokens: 30 },
        latencyMs: 600,
      },
    ],
    usage: { inputTokens: 2100, outputTokens: 90 },
    latencyMs: 1400,
    failure: null,
    warnings: [],
  };
}

const trace: ReplayTrace = {
  id: 'contact_list',
  description: 'a contact list with a team filter',
  mode: 'agent',
  recordedAt: '2025-11-02T10:00:00.000Z',
  result: recordedResult(),
};

/** The tool sequence a live run needs to reach a finalized model. */
function liveTurns() {
  return [
    toolTurn('plan', { summary: 'one contact entity and a table', appName: 'Contact list' }),
    toolTurn('create_entity', {
      id: 'contact',
      name: 'Contact',
      fields: [{ id: 'name', label: 'Name', type: 'string', required: true }],
    }),
    toolTurn('add_component', { id: 'contact_table', type: 'table', entityId: 'contact' }),
    toolTurn('finalize', {}),
  ];
}

let app: FastifyInstance | undefined;

async function startServer(overrides: Partial<Record<string, string>> = {}, live = false) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides });
  const context: ServerContext = {
    config,
    logger: silentLogger,
    metrics: new Metrics(),
    replay: new ReplayStore([trace]),
    provider: live ? new ScriptedProvider(liveTurns()) : undefined,
  };
  app = await buildServer(context);
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('meta routes', () => {
  it('reports replay mode and the number of traces', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      demoMode: 'replay',
      liveGenerationEnabled: false,
      replayTraces: 1,
      schemaVersion: '1.0.0',
    });
  });

  it('lists the prompts a replay deployment can answer', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/api/catalogue' });

    expect(response.json().entries).toEqual([
      { id: 'contact_list', description: trace.description, mode: 'agent' },
    ]);
  });

  it('answers an unknown route with a json error', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });
});

describe('generation in replay mode', () => {
  it('serves a recorded trace', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'A contact list with a team filter.', mode: 'agent' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source).toBe('replay');
    expect(body.ok).toBe(true);
    expect(body.applicationModel.app.name).toBe('Contact list');
    expect(body.estimatedCostUsd).toBe(0);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says what it can answer when there is no recorded trace', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'a spaceship maintenance log' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('replay_miss');
    expect(response.json().error.detail.availableDescriptions).toContain(trace.description);
  });

  it('rejects a description that is too short or too long', async () => {
    const server = await startServer({ MAX_PROMPT_CHARS: '50' });

    const short = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'hi' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('invalid_request');

    const long = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'x'.repeat(51) },
    });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.message).toContain('50 characters');
  });

  it('rejects an unknown mode', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'a contact list with a team filter', mode: 'freestyle' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('generation in live mode', () => {
  it('runs the agent loop and prices the tokens it used', async () => {
    const server = await startServer({ DEMO_MODE: 'live', GEMINI_API_KEY: 'test' }, true);
    const response = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'a contact list', mode: 'agent' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source).toBe('live');
    expect(body.ok).toBe(true);
    expect(body.iterations).toBe(4);
    expect(body.estimatedCostUsd).toBeNull(); // The scripted provider is not in the price table.
  });

  it('requires the access token when one is configured', async () => {
    const server = await startServer(
      { DEMO_MODE: 'live', GEMINI_API_KEY: 'test', DEMO_ACCESS_TOKEN: 'letmein' },
      true,
    );

    const denied = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'a contact list' },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('unauthorised');

    const allowed = await server.inject({
      method: 'POST',
      url: '/api/generate',
      headers: { 'x-demo-token': 'letmein' },
      payload: { description: 'a contact list' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('reports a missing provider rather than crashing', async () => {
    const config = loadConfig({ DEMO_MODE: 'live', LOG_LEVEL: 'silent' });
    app = await buildServer({
      config,
      logger: silentLogger,
      metrics: new Metrics(),
      replay: new ReplayStore(),
      provider: undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'a contact list' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('live_disabled');
  });
});

describe('streaming', () => {
  it('emits the trace as newline delimited json', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/generate/stream',
      payload: { description: 'a contact list with a team filter' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');

    const events = response.payload
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GenerationEvent);

    expect(events[0]).toMatchObject({ type: 'accepted', mode: 'agent', source: 'replay' });
    expect(events.filter((event) => event.type === 'step')).toHaveLength(2);

    const final = events.at(-1);
    expect(final?.type).toBe('result');
    expect(final?.type === 'result' && final.result.applicationModel?.app.name).toBe(
      'Contact list',
    );
  });

  it('reports a replay miss as an error event, not a broken stream', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/generate/stream',
      payload: { description: 'something never recorded' },
    });

    const events = response.payload
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GenerationEvent);

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'replay_miss' });
  });
});

describe('guard rails', () => {
  it('rate limits a caller that asks too often', async () => {
    const server = await startServer({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' });
    const send = () =>
      server.inject({
        method: 'POST',
        url: '/api/generate',
        payload: { description: 'a contact list with a team filter' },
      });

    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);

    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
  });

  it('counts what it served', async () => {
    const server = await startServer();
    await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'a contact list with a team filter' },
    });

    const stats = (await server.inject({ method: 'GET', url: '/api/stats' })).json();
    expect(stats.requests).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.servedFromReplay).toBe(1);
    expect(stats.tokens.input).toBe(0); // Replayed answers spend nothing.
  });
});
