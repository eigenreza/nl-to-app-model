import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { EXAMPLE_MODELS, type GenerationResult } from '@nlam/shared';
import { loadConfig } from '../config.js';
import { Metrics } from '../metrics.js';
import { ReplayStore, type ReplayTrace } from '../replay/store.js';
import { BudgetedProvider } from '../providers/budget.js';
import { ScriptedProvider, toolTurn } from '../providers/scripted.js';
import { DailyBudget } from '../budget/daily-budget.js';
import { DailyBudgetLedger } from '../budget/daily-ledger-adapter.js';
import { LiveAccess } from '../budget/live-access.js';
import { buildServer } from '../server.js';
import type { ServerContext } from '../context.js';

const silentLogger = pino({ level: 'silent' });
const MODEL = 'claude-haiku-4-5-20251001';
const RECORDED = 'a contact list with a team filter';
const NOVEL = 'a greenhouse watering schedule';

function recordedResult(): GenerationResult {
  return {
    ok: true,
    mode: 'agent',
    provider: 'anthropic',
    model: MODEL,
    applicationModel: EXAMPLE_MODELS.contact_list,
    validFirstTry: true,
    iterations: 3,
    steps: [],
    usage: { inputTokens: 2100, outputTokens: 90 },
    latencyMs: 1400,
    failure: null,
    warnings: [],
  };
}

const trace: ReplayTrace = {
  id: 'contact_list',
  description: RECORDED,
  mode: 'agent',
  recordedAt: '2026-03-01T10:00:00.000Z',
  result: recordedResult(),
};

/** A live run that finishes, spending ten cents a turn. */
function liveTurns() {
  const spend = (turn: ReturnType<typeof toolTurn>) => ({
    ...turn,
    usage: { inputTokens: 100_000, outputTokens: 0 },
  });
  return [
    spend(toolTurn('plan', { summary: 'one entity', appName: 'Watering schedule' })),
    spend(
      toolTurn('create_entity', {
        id: 'plant',
        name: 'Plant',
        fields: [{ id: 'name', label: 'Name', type: 'string', required: true }],
      }),
    ),
    spend(toolTurn('add_component', { id: 'plant_table', type: 'table', entityId: 'plant' })),
    spend(toolTurn('finalize', {})),
  ];
}

let directory: string;
let path: string;
let clock: Date;
let app: FastifyInstance | undefined;
let scripted: ScriptedProvider;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nlam-routes-'));
  path = join(directory, 'budget-state.json');
  clock = new Date('2026-03-10T09:00:00.000Z');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(directory, { recursive: true, force: true });
});

interface StartOptions {
  live?: boolean;
  capUsd?: number;
  perIpPerDay?: number;
  maxConcurrent?: number;
  turns?: ReturnType<typeof liveTurns>;
}

async function start(options: StartOptions = {}) {
  const live = options.live ?? true;
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    DEMO_MODE: live ? 'live' : 'replay',
    ANTHROPIC_API_KEY: 'test',
    LLM_PROVIDER: 'anthropic',
    LLM_MODEL: MODEL,
  });

  let dailyBudget: DailyBudget | undefined;
  let provider: ServerContext['provider'];
  let liveAccess: LiveAccess | undefined;

  if (live) {
    dailyBudget = new DailyBudget({
      capUsd: options.capUsd ?? 0.3,
      model: MODEL,
      path,
      reserveUsd: 0.05,
      now: () => clock,
    });
    await dailyBudget.load();

    liveAccess = new LiveAccess({
      perAddressPerDay: options.perIpPerDay ?? 3,
      maxConcurrent: options.maxConcurrent ?? 1,
      now: () => clock,
    });

    scripted = new ScriptedProvider(options.turns ?? liveTurns(), {
      name: 'anthropic',
      model: MODEL,
    });
    provider = new BudgetedProvider(scripted, new DailyBudgetLedger(dailyBudget));
  }

  app = await buildServer({
    config,
    logger: silentLogger,
    metrics: new Metrics(),
    replay: new ReplayStore([trace]),
    provider,
    dailyBudget,
    liveAccess,
  });
  await app.ready();
  return { app, dailyBudget };
}

const generate = (server: FastifyInstance, description: string) =>
  server.inject({ method: 'POST', url: '/api/generate', payload: { description, mode: 'agent' } });

describe('a recorded prompt always wins', () => {
  it('is served from replay even when live generation is available', async () => {
    const { app: server, dailyBudget } = await start();

    const response = await generate(server, RECORDED);

    expect(response.statusCode).toBe(200);
    expect(response.json().source).toBe('replay');
    expect(response.json().estimatedCostUsd).toBe(0);
    // No provider call, so no spend.
    expect(scripted.callCount).toBe(0);
    expect(dailyBudget?.snapshot().spentUsd).toBe(0);
  });

  it('still works after the budget is gone', async () => {
    const { app: server, dailyBudget } = await start({ capUsd: 0.3 });
    await dailyBudget?.record({ inputTokens: 300_000, outputTokens: 0 });

    const response = await generate(server, RECORDED);
    expect(response.statusCode).toBe(200);
    expect(response.json().source).toBe('replay');
  });

  it('still works after this address has used its allowance', async () => {
    const { app: server } = await start({ perIpPerDay: 1 });

    await generate(server, NOVEL); // spends the allowance
    const response = await generate(server, RECORDED);

    expect(response.statusCode).toBe(200);
    expect(response.json().source).toBe('replay');
  });

  it('does not consume the per address allowance', async () => {
    const { app: server } = await start({ perIpPerDay: 1 });

    await generate(server, RECORDED);
    const novel = await generate(server, NOVEL);

    expect(novel.statusCode).toBe(200);
    expect(novel.json().source).toBe('live');
  });
});

describe('a novel prompt goes live', () => {
  it('generates and charges the budget', async () => {
    // Ample, so this test is about the happy path rather than about exhaustion,
    // which mid-generation.test.ts covers directly.
    const { app: server, dailyBudget } = await start({ capUsd: 10 });

    const response = await generate(server, NOVEL);

    expect(response.statusCode).toBe(200);
    expect(response.json().source).toBe('live');
    expect(response.json().ok).toBe(true);
    expect(scripted.callCount).toBe(4);
    expect(dailyBudget?.snapshot().spentUsd).toBeCloseTo(0.4, 4);
    expect(dailyBudget?.snapshot().generations).toBe(1);
  });

  it('is refused with the catalogue when live was never configured', async () => {
    const { app: server } = await start({ live: false });

    const response = await generate(server, NOVEL);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('replay_miss');
    expect(response.json().error.detail.availableDescriptions).toContain(RECORDED);
  });

  it('is refused once the day is spent, and says when it returns', async () => {
    const { app: server, dailyBudget } = await start({ capUsd: 0.3 });
    await dailyBudget?.record({ inputTokens: 290_000, outputTokens: 0 });

    const response = await generate(server, NOVEL);

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('live_budget_exhausted');
    expect(response.json().error.message).toContain('UTC day turns');
    expect(scripted.callCount).toBe(0);
  });

  it('is refused once this address has had its turn', async () => {
    const { app: server } = await start({ perIpPerDay: 1, capUsd: 10 });

    expect((await generate(server, NOVEL)).statusCode).toBe(200);
    const second = await generate(server, 'a different novel prompt entirely');

    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('live_rate_limited');
  });

  it('runs again once the day turns', async () => {
    const { app: server } = await start({ perIpPerDay: 1, capUsd: 10 });
    await generate(server, NOVEL);

    clock = new Date('2026-03-11T00:00:01.000Z');

    const response = await generate(server, 'a different novel prompt entirely');
    expect(response.statusCode).toBe(200);
  });
});

describe('health', () => {
  it('reports the budget so the browser can say what is going on', async () => {
    const { app: server, dailyBudget } = await start({ capUsd: 0.3 });
    await dailyBudget?.record({ inputTokens: 100_000, outputTokens: 0 });

    const live = (await server.inject({ method: 'GET', url: '/api/health' })).json().live;

    expect(live).toMatchObject({
      configured: true,
      available: true,
      dailyCapUsd: 0.3,
      spentTodayUsd: 0.1,
      remainingUsd: 0.2,
      utcDate: '2026-03-10',
    });
  });

  it('says why live is unavailable once the budget is gone', async () => {
    const { app: server, dailyBudget } = await start({ capUsd: 0.3 });
    await dailyBudget?.record({ inputTokens: 290_000, outputTokens: 0 });

    const live = (await server.inject({ method: 'GET', url: '/api/health' })).json().live;

    expect(live).toMatchObject({ available: false, reason: 'budget_exhausted' });
  });

  it('omits the live block entirely on a replay-only deployment', async () => {
    const { app: server } = await start({ live: false });
    const body = (await server.inject({ method: 'GET', url: '/api/health' })).json();

    expect(body.live).toBeUndefined();
    expect(body.liveGenerationEnabled).toBe(false);
  });
});

describe('input cap', () => {
  it('rejects an oversized description before any guard is consulted', async () => {
    const { app: server } = await start({ perIpPerDay: 1 });

    const response = await server.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { description: 'x'.repeat(5_000), mode: 'agent' },
    });

    expect(response.statusCode).toBe(400);
    expect(scripted.callCount).toBe(0);
  });
});
