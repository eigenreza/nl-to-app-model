import { describe, expect, it, vi } from 'vitest';
import type { TokenUsage } from '@nlam/shared';
import { BudgetedProvider, SpendCapExceededError, SpendGuard } from './budget.js';
import { ScriptedProvider, textTurn } from './scripted.js';

/** Haiku pricing: $1 per million input, $5 per million output. */
const MODEL = 'claude-haiku-4-5-20251001';

function guardWith(capUsd: number, reserveUsd = 0) {
  return new SpendGuard({ capUsd, model: MODEL, reserveUsd });
}

describe('SpendGuard', () => {
  it('prices ordinary input and output at the published rate', () => {
    const guard = guardWith(10);
    guard.record({ inputTokens: 1_000_000, outputTokens: 200_000 });

    // 1.00 for input plus 1.00 for output.
    expect(guard.spentUsd).toBeCloseTo(2, 4);
    expect(guard.callCount).toBe(1);
  });

  it('prices cache writes above and cache reads below ordinary input', () => {
    const write = guardWith(10);
    write.record({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(write.spentUsd).toBeCloseTo(1.25, 4);

    const read = guardWith(10);
    read.record({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(read.spentUsd).toBeCloseTo(0.1, 4);
  });

  it('counts batch work at half rate, since that is what it costs', () => {
    const guard = guardWith(10);
    guard.record({ inputTokens: 1_000_000, outputTokens: 0 }, 0.5);
    expect(guard.spentUsd).toBeCloseTo(0.5, 4);
  });

  it('accumulates usage across calls', () => {
    const guard = guardWith(10);
    guard.record({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
    guard.record({ inputTokens: 200, outputTokens: 20 });

    expect(guard.totalUsage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 5,
    });
  });

  it('allows calls while there is headroom and refuses once there is not', () => {
    const guard = guardWith(1);
    expect(() => guard.assertHeadroom()).not.toThrow();

    guard.record({ inputTokens: 900_000, outputTokens: 0 }); // $0.90
    expect(() => guard.assertHeadroom()).not.toThrow();

    guard.record({ inputTokens: 150_000, outputTokens: 0 }); // takes it past $1
    expect(() => guard.assertHeadroom()).toThrow(SpendCapExceededError);
  });

  it('stops before the cap rather than at it, keeping a reserve back', () => {
    const guard = new SpendGuard({ capUsd: 1, model: MODEL, reserveUsd: 0.2 });
    guard.record({ inputTokens: 850_000, outputTokens: 0 }); // $0.85, under the cap

    // Still under $1, but not by enough to risk another call.
    expect(guard.spentUsd).toBeLessThan(1);
    expect(() => guard.assertHeadroom()).toThrow(SpendCapExceededError);
  });

  it('never refuses when no cap is configured', () => {
    const guard = guardWith(0);
    guard.record({ inputTokens: 100_000_000, outputTokens: 0 });
    expect(() => guard.assertHeadroom()).not.toThrow();
  });

  it('reports what remains', () => {
    const guard = guardWith(1);
    guard.record({ inputTokens: 250_000, outputTokens: 0 });
    expect(guard.remainingUsd).toBeCloseTo(0.75, 4);
  });

  it('tells the caller how far past the cap it got', () => {
    const guard = guardWith(0.5);
    guard.record({ inputTokens: 600_000, outputTokens: 0 });

    try {
      guard.assertHeadroom();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SpendCapExceededError);
      expect((error as SpendCapExceededError).message).toContain('$0.6000 of $0.50');
      expect((error as SpendCapExceededError).message).toContain('Nothing further was sent');
    }
  });
});

describe('BudgetedProvider', () => {
  it('passes calls through and counts what they cost', async () => {
    const guard = guardWith(10);
    const inner = new ScriptedProvider([
      { ...textTurn('one'), usage: { inputTokens: 1_000, outputTokens: 100 } },
    ]);
    const provider = new BudgetedProvider(inner, guard);

    const response = await provider.complete({ system: '', messages: [] });

    expect(response.text).toBe('one');
    expect(guard.callCount).toBe(1);
    expect(guard.spentUsd).toBeGreaterThan(0);
    expect(provider.name).toBe('scripted');
  });

  it('refuses to make the call at all once the cap is in sight', async () => {
    const guard = guardWith(0.001);
    guard.record({ inputTokens: 1_000_000, outputTokens: 0 });

    const inner = new ScriptedProvider([textTurn('should never be reached')]);
    const complete = vi.spyOn(inner, 'complete');
    const provider = new BudgetedProvider(inner, guard);

    await expect(provider.complete({ system: '', messages: [] })).rejects.toBeInstanceOf(
      SpendCapExceededError,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('counts a call whose usage the provider reported as zero', async () => {
    const guard = guardWith(10);
    const inner = new ScriptedProvider([{ text: 'x', usage: { inputTokens: 0, outputTokens: 0 } }]);
    const provider = new BudgetedProvider(inner, guard);

    await provider.complete({ system: '', messages: [] });
    expect(guard.callCount).toBe(1);
  });
});

describe('usage arithmetic', () => {
  it('leaves cache fields absent when nothing was cached', () => {
    const guard = guardWith(10);
    guard.record({ inputTokens: 10, outputTokens: 1 } satisfies TokenUsage);
    expect(guard.totalUsage.cacheReadTokens).toBeUndefined();
    expect(guard.totalUsage.cacheWriteTokens).toBeUndefined();
  });
});
