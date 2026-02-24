import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyBudget, UnpricedModelError, utcDateOf } from './daily-budget.js';

/** Haiku pricing: $1 per million input, $5 per million output. */
const MODEL = 'claude-haiku-4-5-20251001';

/** $1.00 of input, so arithmetic in these tests is legible. */
const ONE_DOLLAR = { inputTokens: 1_000_000, outputTokens: 0 };
const ONE_CENT = { inputTokens: 10_000, outputTokens: 0 };

let directory: string;
let path: string;
/** Advanced by hand so a day can be made to turn without waiting for one. */
let clock: Date;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nlam-budget-'));
  path = join(directory, 'budget-state.json');
  clock = new Date('2026-03-10T09:00:00.000Z');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function budget(capUsd = 0.3, reserveUsd = 0.05) {
  return new DailyBudget({ capUsd, model: MODEL, path, reserveUsd, now: () => clock });
}

describe('metering', () => {
  it('refuses a model it cannot price, rather than running unmetered', () => {
    expect(() => new DailyBudget({ capUsd: 1, model: 'some-unlisted-model', path })).toThrow(
      UnpricedModelError,
    );
  });

  it('starts a fresh day at zero', async () => {
    const daily = budget();
    await daily.load();

    expect(daily.snapshot()).toMatchObject({
      spentUsd: 0,
      remainingUsd: 0.3,
      generations: 0,
      exhausted: false,
      utcDate: '2026-03-10',
    });
  });

  it('charges what the provider reported, including cached tokens', async () => {
    const daily = budget(10);
    await daily.load();

    await daily.record({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(daily.snapshot().spentUsd).toBeCloseTo(0.1, 4);

    await daily.record({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(daily.snapshot().spentUsd).toBeCloseTo(1.35, 4);
  });

  it('counts batch work at half rate', async () => {
    const daily = budget(10);
    await daily.load();

    await daily.record(ONE_DOLLAR, 0.5);
    expect(daily.snapshot().spentUsd).toBeCloseTo(0.5, 4);
  });

  it('accumulates the token totals it was told about', async () => {
    const daily = budget(10);
    await daily.load();

    await daily.record({ inputTokens: 100, outputTokens: 10 });
    await daily.record({ inputTokens: 200, outputTokens: 20 });

    expect(daily.snapshot().usage).toEqual({ inputTokens: 300, outputTokens: 30 });
  });
});

describe('exhaustion', () => {
  it('stops accepting new generations once the reserve is gone', async () => {
    const daily = budget(0.3, 0.05);
    await daily.load();

    await daily.record({ inputTokens: 200_000, outputTokens: 0 }); // $0.20
    expect(daily.canStartGeneration()).toBe(true);

    await daily.record({ inputTokens: 60_000, outputTokens: 0 }); // $0.26 total
    expect(daily.canStartGeneration()).toBe(false);
    expect(daily.snapshot().exhausted).toBe(true);
  });

  it('lets a generation already under way spend into the reserve', async () => {
    const daily = budget(0.3, 0.05);
    await daily.load();
    await daily.record({ inputTokens: 260_000, outputTokens: 0 }); // $0.26

    // No new generation may start, but the one in flight may finish.
    expect(daily.canStartGeneration()).toBe(false);
    expect(daily.canMakeCall()).toBe(true);
  });

  it('refuses further calls once the cap itself is reached', async () => {
    const daily = budget(0.3, 0.05);
    await daily.load();

    await daily.record({ inputTokens: 300_000, outputTokens: 0 }); // exactly $0.30
    expect(daily.canMakeCall()).toBe(false);
    expect(daily.snapshot().remainingUsd).toBe(0);
  });

  it('never reports a negative remainder after an overshoot', async () => {
    const daily = budget(0.3);
    await daily.load();

    await daily.record(ONE_DOLLAR);
    expect(daily.snapshot().remainingUsd).toBe(0);
    expect(daily.snapshot().spentUsd).toBeCloseTo(1, 4);
  });
});

describe('persistence across a restart', () => {
  it('a new instance picks up what the previous one spent', async () => {
    const first = budget();
    await first.load();
    await first.record({ inputTokens: 150_000, outputTokens: 0 }); // $0.15
    await first.countGeneration();

    // A restart: a completely separate instance, same file.
    const second = budget();
    await second.load();

    expect(second.snapshot().spentUsd).toBeCloseTo(0.15, 4);
    expect(second.snapshot().generations).toBe(1);
    expect(second.snapshot().remainingUsd).toBeCloseTo(0.15, 4);
  });

  it('a restart cannot hand out a fresh allowance', async () => {
    const first = budget();
    await first.load();
    await first.record({ inputTokens: 290_000, outputTokens: 0 }); // $0.29
    expect(first.canStartGeneration()).toBe(false);

    const second = budget();
    await second.load();
    expect(second.canStartGeneration()).toBe(false);
  });

  it('writes a file that is valid json after every record', async () => {
    const daily = budget();
    await daily.load();
    await daily.record(ONE_CENT);

    const written = JSON.parse(await readFile(path, 'utf8'));
    expect(written).toMatchObject({ utcDate: '2026-03-10' });
    expect(written.spentUsd).toBeCloseTo(0.01, 4);
  });

  it('starts clean when the ledger is missing', async () => {
    const daily = budget();
    await daily.load();
    expect(daily.snapshot().spentUsd).toBe(0);
  });

  it('starts clean when the ledger is corrupt rather than refusing to run', async () => {
    await writeFile(path, '{ this is not json', 'utf8');

    const daily = budget();
    await daily.load();
    expect(daily.snapshot().spentUsd).toBe(0);
  });

  it('ignores a ledger whose numbers are not numbers', async () => {
    await writeFile(path, JSON.stringify({ utcDate: '2026-03-10', spentUsd: 'lots' }), 'utf8');

    const daily = budget();
    await daily.load();
    expect(daily.snapshot().spentUsd).toBe(0);
  });

  it('treats a negative spend in the file as zero', async () => {
    await writeFile(path, JSON.stringify({ utcDate: '2026-03-10', spentUsd: -5 }), 'utf8');

    const daily = budget();
    await daily.load();
    expect(daily.snapshot().spentUsd).toBe(0);
  });
});

describe('utc rollover', () => {
  it('resets when the day turns', async () => {
    const daily = budget();
    await daily.load();
    await daily.record({ inputTokens: 290_000, outputTokens: 0 });
    expect(daily.canStartGeneration()).toBe(false);

    clock = new Date('2026-03-11T00:00:01.000Z');

    expect(daily.snapshot()).toMatchObject({ utcDate: '2026-03-11', spentUsd: 0, generations: 0 });
    expect(daily.canStartGeneration()).toBe(true);
  });

  it('does not reset within the same UTC day, whatever the local hour', async () => {
    const daily = budget();
    await daily.load();
    await daily.record({ inputTokens: 100_000, outputTokens: 0 });

    clock = new Date('2026-03-10T23:59:59.000Z');
    expect(daily.snapshot().spentUsd).toBeCloseTo(0.1, 4);
  });

  it('a restart on a later day starts that day at zero', async () => {
    const first = budget();
    await first.load();
    await first.record({ inputTokens: 290_000, outputTokens: 0 });

    clock = new Date('2026-03-12T08:00:00.000Z');

    const second = budget();
    await second.load();
    expect(second.snapshot().spentUsd).toBe(0);
    expect(second.snapshot().utcDate).toBe('2026-03-12');
    expect(second.canStartGeneration()).toBe(true);
  });

  it('spending after a rollover belongs to the new day', async () => {
    const daily = budget();
    await daily.load();
    await daily.record({ inputTokens: 100_000, outputTokens: 0 });

    clock = new Date('2026-03-11T06:00:00.000Z');
    await daily.record({ inputTokens: 50_000, outputTokens: 0 });

    const snapshot = daily.snapshot();
    expect(snapshot.utcDate).toBe('2026-03-11');
    expect(snapshot.spentUsd).toBeCloseTo(0.05, 4);
  });

  it('reports the UTC day, not the local one', () => {
    // Late evening in UTC is already the next day in some zones and not others;
    // the ledger follows UTC so that a deployment does not get two allowances.
    expect(utcDateOf(new Date('2026-03-10T23:30:00.000Z'))).toBe('2026-03-10');
    expect(utcDateOf(new Date('2026-03-11T00:30:00.000Z'))).toBe('2026-03-11');
  });
});

describe('notifications', () => {
  it('reports each change, and says when the budget has gone', async () => {
    const seen: boolean[] = [];
    const daily = new DailyBudget({
      capUsd: 0.3,
      model: MODEL,
      path,
      reserveUsd: 0.05,
      now: () => clock,
      onChange: (snapshot) => seen.push(snapshot.exhausted),
    });
    await daily.load();

    await daily.record({ inputTokens: 100_000, outputTokens: 0 });
    await daily.record({ inputTokens: 180_000, outputTokens: 0 });

    expect(seen).toEqual([false, true]);
  });
});
