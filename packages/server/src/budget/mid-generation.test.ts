import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateWithAgent } from '../generation/agent.js';
import { BudgetedProvider } from '../providers/budget.js';
import { ScriptedProvider, toolTurn } from '../providers/scripted.js';
import { DailyBudget } from './daily-budget.js';
import { DailyBudgetExhaustedError, DailyBudgetLedger } from './daily-ledger-adapter.js';

const MODEL = 'claude-haiku-4-5-20251001';

/** Each turn spends $0.10 of input, so the day runs out on a known call. */
const TEN_CENTS = { inputTokens: 100_000, outputTokens: 0 };

const CONTACT_ENTITY = {
  id: 'contact',
  name: 'Contact',
  fields: [
    { id: 'name', label: 'Name', type: 'string', required: true },
    { id: 'team', label: 'Team', type: 'enum', options: ['Design', 'Engineering'] },
  ],
};

/** A run that would finish cleanly, if it were allowed to. */
function fullRun() {
  const spend = (turn: ReturnType<typeof toolTurn>) => ({ ...turn, usage: TEN_CENTS });
  return [
    spend(toolTurn('plan', { summary: 'one contact entity', appName: 'Contact list' })),
    spend(toolTurn('create_entity', CONTACT_ENTITY)),
    spend(toolTurn('add_component', { id: 'contact_table', type: 'table', entityId: 'contact' })),
    spend(
      toolTurn('add_component', {
        id: 'by_team',
        type: 'metric',
        entityId: 'contact',
        aggregate: 'count',
      }),
    ),
    spend(toolTurn('finalize', {})),
  ];
}

let directory: string;
let path: string;
let clock: Date;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nlam-midgen-'));
  path = join(directory, 'budget-state.json');
  clock = new Date('2026-03-10T09:00:00.000Z');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function budgetedProvider(capUsd: number, turns = fullRun()) {
  const budget = new DailyBudget({
    capUsd,
    model: MODEL,
    path,
    reserveUsd: 0.05,
    now: () => clock,
  });
  await budget.load();

  const scripted = new ScriptedProvider(turns, { name: 'anthropic', model: MODEL });
  return { budget, scripted, provider: new BudgetedProvider(scripted, new DailyBudgetLedger(budget)) };
}

describe('running out part way through a generation', () => {
  it('stops calling, salvages what was built, and explains why', async () => {
    // Room for three calls at ten cents, and the run wants five.
    const { budget, scripted, provider } = await budgetedProvider(0.3);

    const result = await generateWithAgent({ description: 'a contact list', provider });

    expect(scripted.callCount).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('provider_error');
    expect(result.failure?.message).toContain('budget for today');

    // The entity and the table were applied before the money ran out, so a
    // partial application comes back rather than nothing at all.
    expect(result.applicationModel).not.toBeNull();
    expect(result.applicationModel?.entities[0]?.id).toBe('contact');
    expect(result.applicationModel?.components.map((c) => c.id)).toEqual(['contact_table']);

    expect(budget.snapshot().spentUsd).toBeCloseTo(0.3, 4);
    expect(budget.canMakeCall()).toBe(false);
  });

  it('records every call it did make, not only the ones that finished the job', async () => {
    const { budget } = await budgetedProvider(0.3);
    expect(budget.snapshot().spentUsd).toBe(0);

    const { budget: after, provider } = await budgetedProvider(0.3);
    await generateWithAgent({ description: 'a contact list', provider });

    expect(after.snapshot().spentUsd).toBeCloseTo(0.3, 4);
  });

  it('leaves the ledger on disk so the next process starts exhausted', async () => {
    const { provider } = await budgetedProvider(0.3);
    await generateWithAgent({ description: 'a contact list', provider });

    // A restart: fresh instance, same file.
    const restarted = new DailyBudget({ capUsd: 0.3, model: MODEL, path, now: () => clock });
    await restarted.load();

    expect(restarted.snapshot().spentUsd).toBeCloseTo(0.3, 4);
    expect(restarted.canStartGeneration()).toBe(false);
  });

  it('finishes normally when the budget is ample', async () => {
    const { budget, scripted, provider } = await budgetedProvider(10);

    const result = await generateWithAgent({ description: 'a contact list', provider });

    expect(result.ok).toBe(true);
    expect(scripted.callCount).toBe(5);
    expect(result.applicationModel?.components).toHaveLength(2);
    expect(budget.snapshot().spentUsd).toBeCloseTo(0.5, 4);
  });

  it('refuses the very first call when the day is already gone', async () => {
    const spent = new DailyBudget({ capUsd: 0.3, model: MODEL, path, now: () => clock });
    await spent.load();
    await spent.record({ inputTokens: 300_000, outputTokens: 0 });

    const { scripted, provider } = await budgetedProvider(0.3);
    const result = await generateWithAgent({ description: 'a contact list', provider });

    expect(scripted.callCount).toBe(0);
    expect(result.applicationModel).toBeNull();
    expect(result.failure?.reason).toBe('provider_error');
  });

  it('the refusal names the amount and the cap rather than saying only no', async () => {
    const budget = new DailyBudget({ capUsd: 0.3, model: MODEL, path, now: () => clock });
    await budget.load();
    await budget.record({ inputTokens: 300_000, outputTokens: 0 });

    const ledger = new DailyBudgetLedger(budget);
    try {
      ledger.assertHeadroom();
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DailyBudgetExhaustedError);
      expect((error as Error).message).toContain('$0.3000 of $0.30');
      expect((error as Error).message).toContain('sample prompts still work');
    }
  });

  it('a generation blocked yesterday runs once the day turns', async () => {
    const { provider: first } = await budgetedProvider(0.3);
    await generateWithAgent({ description: 'a contact list', provider: first });

    clock = new Date('2026-03-11T00:00:01.000Z');

    const { budget, scripted, provider } = await budgetedProvider(0.3);
    expect(budget.canStartGeneration()).toBe(true);

    const result = await generateWithAgent({ description: 'a contact list', provider });
    expect(scripted.callCount).toBe(3);
    expect(result.applicationModel).not.toBeNull();
  });
});
