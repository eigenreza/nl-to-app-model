/**
 * Regression cover for a bug that only appeared over a real socket.
 *
 * The streaming route aborted every live generation the instant it started,
 * because it listened for 'close' on the request. Node emits that when the
 * request has been *completed*, not only when a client disconnects, and Fastify
 * has already read and parsed the JSON body before the handler runs. So the
 * request stream was finished, 'close' fired immediately, and the abort signal
 * was raised before the first provider call.
 *
 * It hid well. Replay never looks at the signal, the non-streaming route never
 * built one, and fastify's inject() does not model the socket faithfully
 * enough to reproduce it. Only the browser, on the streaming route, on a
 * description nobody had recorded, hit all four conditions at once. These
 * tests therefore run a real server over a real port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import type { GenerationEvent, GenerationMode } from '@nlam/shared';
import { loadConfig } from '../config.js';
import { Metrics } from '../metrics.js';
import { ReplayStore } from '../replay/store.js';
import { BudgetedProvider } from '../providers/budget.js';
import { ProviderError } from '../providers/types.js';
import { textTurn, toolTurn } from '../providers/scripted.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';
import { DailyBudget } from '../budget/daily-budget.js';
import { DailyBudgetLedger } from '../budget/daily-ledger-adapter.js';
import { LiveAccess } from '../budget/live-access.js';
import { buildServer } from '../server.js';

const silentLogger = pino({ level: 'silent' });
const MODEL = 'claude-haiku-4-5-20251001';

/** The whole document, as a baseline completion returns it. */
const HELLO_MODEL = JSON.stringify({
  app: { name: 'Hello World' },
  entities: [
    {
      id: 'greeting',
      name: 'Greeting',
      fields: [{ id: 'message', label: 'Message', type: 'string', required: true }],
      seed: [{ message: 'Hello world' }],
    },
  ],
  components: [{ id: 'greeting_table', type: 'table', entityId: 'greeting' }],
  layout: { type: 'vertical' },
});

function agentTurns() {
  return [
    toolTurn('plan', { summary: 'one greeting entity', appName: 'Hello World' }),
    toolTurn('create_entity', {
      id: 'greeting',
      name: 'Greeting',
      fields: [{ id: 'message', label: 'Message', type: 'string', required: true }],
    }),
    toolTurn('add_component', { id: 'greeting_table', type: 'table', entityId: 'greeting' }),
    toolTurn('finalize', {}),
  ];
}

/**
 * A provider that takes time, the way a real one does, and reports whether the
 * abort signal was raised while it was working.
 *
 * This is the part the first attempt at this test got wrong. A provider that
 * answers instantly finishes before the stray 'close' event lands, so the bug
 * does not reproduce. Measured: the event arrived about two milliseconds in,
 * and every real call takes seconds.
 */
class SlowProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model = MODEL;
  /** True when a call observed the signal already aborted. */
  abortedDuringCall = false;
  callCount = 0;

  constructor(
    private readonly turns: readonly Partial<CompletionResponse>[],
    private readonly delayMs = 120,
  ) {}

  async complete(_request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const turn = this.turns[this.callCount];
    this.callCount += 1;

    await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    if (signal?.aborted) {
      this.abortedDuringCall = true;
      // What the SDK does when its signal fires, and what the report showed.
      throw new ProviderError('Anthropic request failed with status unknown: Request was aborted', {
        provider: 'anthropic',
      });
    }

    if (!turn) throw new ProviderError('scripted turns exhausted', { provider: 'anthropic' });
    return fullTurn(turn);
  }
}

/** Fills in the fields a partial turn leaves out. */
function fullTurn(overrides: Partial<CompletionResponse>): CompletionResponse {
  return {
    text: '',
    toolCalls: [],
    usage: { inputTokens: 1_000, outputTokens: 500 },
    finishReason: 'stop',
    latencyMs: 0,
    ...overrides,
  };
}

let directory: string;
let app: FastifyInstance | undefined;
let baseUrl: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nlam-abort-'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function startLiveServer(turns: readonly Partial<CompletionResponse>[]) {
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    DEMO_MODE: 'live',
    LLM_PROVIDER: 'anthropic',
    LLM_MODEL: MODEL,
    ANTHROPIC_API_KEY: 'test',
  });

  const dailyBudget = new DailyBudget({
    capUsd: 10,
    model: MODEL,
    path: join(directory, 'budget-state.json'),
  });
  await dailyBudget.load();

  const scripted = new SlowProvider(turns);

  app = await buildServer({
    config,
    logger: silentLogger,
    metrics: new Metrics(),
    // Empty on purpose: every description here is one nobody recorded, which is
    // the only path that reaches the provider and therefore the signal.
    replay: new ReplayStore(),
    provider: new BudgetedProvider(scripted, new DailyBudgetLedger(dailyBudget)),
    dailyBudget,
    liveAccess: new LiveAccess({ perAddressPerDay: 100, maxConcurrent: 4 }),
  });

  // A real port, because the bug lives in how Node treats a real request stream.
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  return { scripted, dailyBudget };
}

/** Posts to the streaming route and collects every event it emits. */
async function streamEvents(description: string, mode: GenerationMode): Promise<GenerationEvent[]> {
  const response = await fetch(`${baseUrl}/api/generate/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description, mode }),
  });

  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GenerationEvent);
}

describe('a live generation over a real connection', () => {
  it('is not aborted the moment the request body has been read, in baseline mode', async () => {
    const { scripted } = await startLiveServer([textTurn(HELLO_MODEL)]);

    const events = await streamEvents('Just a simple app to say hello world!', 'baseline');
    const final = events.at(-1);

    expect(final?.type).toBe('result');
    if (final?.type !== 'result') throw new Error(JSON.stringify(final));

    expect(final.result.ok).toBe(true);
    expect(final.result.source).toBe('live');
    expect(final.result.iterations).toBe(1);
    expect(final.result.applicationModel?.app.name).toBe('Hello World');
    expect(scripted.callCount).toBe(1);
  });

  it('is not aborted in agent mode either', async () => {
    const { scripted } = await startLiveServer(agentTurns());

    const events = await streamEvents('Just a simple app to say hello world!', 'agent');
    const final = events.at(-1);

    expect(final?.type).toBe('result');
    if (final?.type !== 'result') throw new Error(JSON.stringify(final));

    expect(final.result.ok).toBe(true);
    expect(final.result.iterations).toBe(4);
    expect(scripted.callCount).toBe(4);
  });

  it('reaches the provider at all, rather than failing before any work', async () => {
    // The shape of the original report: zero iterations, zero tokens, no time.
    const { scripted, dailyBudget } = await startLiveServer([
      { ...textTurn(HELLO_MODEL), usage: { inputTokens: 1_000, outputTokens: 500 } },
    ]);

    await streamEvents('Just a simple app to say hello world!', 'baseline');

    expect(scripted.callCount).toBeGreaterThan(0);
    expect(dailyBudget.snapshot().spentUsd).toBeGreaterThan(0);
  });

  it('streams the steps as they happen rather than only at the end', async () => {
    await startLiveServer(agentTurns());

    const events = await streamEvents('a hello world application', 'agent');

    expect(events[0]?.type).toBe('accepted');
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(0);
  });
});

describe('a caller who goes away', () => {
  it('still stops the generation, which is what the signal is for', async () => {
    // The fix must not amount to deleting the feature: an abandoned tab should
    // not keep spending iterations.
    const { scripted } = await startLiveServer(agentTurns());

    const client = new AbortController();
    const pending = fetch(`${baseUrl}/api/generate/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'an abandoned request', mode: 'agent' }),
      signal: client.signal,
    }).catch(() => undefined);

    // Long enough for the handler to be running, short enough to land inside
    // the first provider call.
    await new Promise((resolve) => setTimeout(resolve, 40));
    client.abort();
    await pending;

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(scripted.abortedDuringCall).toBe(true);
    // It stopped rather than running the loop out.
    expect(scripted.callCount).toBeLessThan(4);
  });
});
