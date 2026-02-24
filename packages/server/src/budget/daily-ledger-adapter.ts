/**
 * Presents the persisted daily budget as something a provider can be wrapped
 * in, so the same decorator serves both the eval's in-process guard and the
 * demo's on-disk one.
 *
 * The important case is exhaustion part way through a generation. The agent
 * loop has already made two or three calls, the day runs out, and the next call
 * is refused. That refusal travels the same path as any other provider failure:
 * the loop records it, salvages the best model the draft still validates as,
 * and returns it with a report saying why it stopped. A visitor gets a partial
 * application and an explanation rather than an error page.
 */
import type { TokenUsage } from '@nlam/shared';
import type { SpendLedger } from '../providers/budget.js';
import type { DailyBudget } from './daily-budget.js';

export class DailyBudgetExhaustedError extends Error {
  readonly code = 'daily_budget_exhausted';

  constructor(spentUsd: number, capUsd: number) {
    super(
      `The demo has spent its budget for today: $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}. ` +
        'Live generation resumes when the UTC day turns. The recorded sample prompts still work.',
    );
    this.name = 'DailyBudgetExhaustedError';
  }
}

export class DailyBudgetLedger implements SpendLedger {
  constructor(private readonly budget: DailyBudget) {}

  assertHeadroom(): void {
    if (this.budget.canMakeCall()) return;
    const snapshot = this.budget.snapshot();
    throw new DailyBudgetExhaustedError(snapshot.spentUsd, snapshot.capUsd);
  }

  async record(usage: TokenUsage, rateMultiplier = 1): Promise<void> {
    await this.budget.record(usage, rateMultiplier);
  }
}
