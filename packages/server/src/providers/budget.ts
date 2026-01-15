/**
 * A spend ceiling that is enforced rather than intended.
 *
 * An estimate made before a batch is a prediction, and predictions about token
 * counts are wrong often enough that a run against prepaid credit needs
 * something stronger. This tracks what has actually been spent, from the token
 * counts the provider reports, and refuses to make the next call once the
 * ceiling is in sight.
 *
 * It stops before the cap rather than at it. Cost is only known after a call
 * returns, so the guard keeps back enough headroom for one more call than it
 * expects to allow, and treats the reserve as spent when deciding.
 */
import { addUsage, emptyUsage, type TokenUsage } from '@nlam/shared';
import { estimateCostUsd } from './pricing.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from './types.js';

export class SpendCapExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `Spend cap reached: $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} used, which leaves too little headroom for another call. ` +
        'Nothing further was sent. Raise the cap deliberately, or rerun later; completed work is cached.',
    );
    this.name = 'SpendCapExceededError';
  }
}

export interface SpendGuardOptions {
  capUsd: number;
  model: string;
  /**
   * Held back so the cap is never crossed by the call that discovers it. Set
   * from the largest single call this workload plausibly makes.
   */
  reserveUsd?: number;
  onSpend?: (info: { spentUsd: number; capUsd: number; usage: TokenUsage }) => void;
}

export class SpendGuard {
  private usage: TokenUsage = emptyUsage();
  private spent = 0;
  private calls = 0;

  constructor(private readonly options: SpendGuardOptions) {}

  get spentUsd(): number {
    return this.spent;
  }

  get callCount(): number {
    return this.calls;
  }

  get totalUsage(): TokenUsage {
    return this.usage;
  }

  get remainingUsd(): number {
    return Math.max(0, this.options.capUsd - this.spent);
  }

  private get reserve(): number {
    return this.options.reserveUsd ?? 0.05;
  }

  /** Throws when another call could take the total past the cap. */
  assertHeadroom(): void {
    if (this.options.capUsd <= 0) return; // No cap configured.
    if (this.spent + this.reserve > this.options.capUsd) {
      throw new SpendCapExceededError(this.spent, this.options.capUsd);
    }
  }

  /**
   * @param rateMultiplier Scales the list price for this call. Batch work is
   * billed at half, so counting it at full rate would stop a run early for
   * money that was never spent.
   */
  record(usage: TokenUsage, rateMultiplier = 1): void {
    this.calls += 1;
    this.usage = addUsage(this.usage, usage);
    this.spent += (estimateCostUsd(this.options.model, usage) ?? 0) * rateMultiplier;
    this.options.onSpend?.({ spentUsd: this.spent, capUsd: this.options.capUsd, usage });
  }
}

/**
 * Wraps a provider so that no call can be made once the ceiling is in sight,
 * and every call that is made is counted.
 */
export class BudgetedProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly inner: LLMProvider,
    readonly guard: SpendGuard,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    this.guard.assertHeadroom();
    const response = await this.inner.complete(request, signal);
    this.guard.record(response.usage);
    return response;
  }
}
