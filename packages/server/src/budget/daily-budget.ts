/**
 * A spend ceiling for one UTC day, held on disk.
 *
 * The in-process spend guard used by the eval is enough for a run somebody is
 * watching. A public demo is not watched: it runs unattended, it restarts, and
 * an in-memory counter resets to zero every time it does. So this one persists,
 * and it is the persistence that makes it a budget rather than a wish.
 *
 * Everything is computed from token counts the provider actually reported, not
 * from an estimate made beforehand. A model with no published price cannot be
 * metered, so live generation refuses to run on one at all: failing closed is
 * the only safe reading of "I do not know what that cost".
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { addUsage, emptyUsage, type TokenUsage } from '@nlam/shared';
import { estimateCostUsd, pricingFor } from '../providers/pricing.js';

export interface DailyBudgetState {
  /** The UTC day these totals belong to, as YYYY-MM-DD. */
  utcDate: string;
  spentUsd: number;
  generations: number;
  usage: TokenUsage;
}

export interface DailyBudgetSnapshot extends DailyBudgetState {
  capUsd: number;
  remainingUsd: number;
  /** True when there is not enough left to begin another generation. */
  exhausted: boolean;
}

export interface DailyBudgetOptions {
  capUsd: number;
  model: string;
  /** Where the ledger is kept. Must survive a restart to be worth anything. */
  path: string;
  /**
   * Held back so a generation is only started when there is plausibly enough
   * left to finish it. Measured: an agent-mode generation cost about $0.023 on
   * the eval, so the default leaves room for roughly two.
   */
  reserveUsd?: number;
  now?: () => Date;
  onChange?: (snapshot: DailyBudgetSnapshot) => void;
}

export class UnpricedModelError extends Error {
  constructor(model: string) {
    super(
      `No published price is on record for "${model}", so its spend cannot be metered. ` +
        'Live generation refuses to run unmetered. Add the model to the pricing table, or leave live generation off.',
    );
    this.name = 'UnpricedModelError';
  }
}

export function utcDateOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function freshState(utcDate: string): DailyBudgetState {
  return { utcDate, spentUsd: 0, generations: 0, usage: emptyUsage() };
}

export class DailyBudget {
  private state: DailyBudgetState;
  private readonly now: () => Date;
  /** Writes are serialised so two finishing generations cannot interleave. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: DailyBudgetOptions) {
    if (!pricingFor(options.model)) throw new UnpricedModelError(options.model);
    this.now = options.now ?? (() => new Date());
    this.state = freshState(utcDateOf(this.now()));
  }

  private get reserve(): number {
    return this.options.reserveUsd ?? 0.05;
  }

  /** Reads any ledger left by a previous run. A missing file is a fresh day. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.options.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DailyBudgetState>;

      if (
        typeof parsed.utcDate === 'string' &&
        typeof parsed.spentUsd === 'number' &&
        Number.isFinite(parsed.spentUsd)
      ) {
        this.state = {
          utcDate: parsed.utcDate,
          spentUsd: Math.max(0, parsed.spentUsd),
          generations: typeof parsed.generations === 'number' ? parsed.generations : 0,
          usage:
            parsed.usage && typeof parsed.usage.inputTokens === 'number'
              ? parsed.usage
              : emptyUsage(),
        };
      }
    } catch {
      // No ledger, or one that cannot be read. Either way today starts at zero,
      // which is the safe direction to be wrong in only because the cap is
      // small; a corrupt ledger is reported by the snapshot being back at zero.
    }
    this.rollOver();
  }

  /** Resets the totals when the UTC day has turned. */
  private rollOver(): void {
    const today = utcDateOf(this.now());
    if (this.state.utcDate !== today) this.state = freshState(today);
  }

  snapshot(): DailyBudgetSnapshot {
    this.rollOver();
    const remainingUsd = Math.max(0, this.options.capUsd - this.state.spentUsd);
    return {
      ...this.state,
      capUsd: this.options.capUsd,
      remainingUsd,
      exhausted: remainingUsd < this.reserve,
    };
  }

  /** True when there is enough left to be worth beginning a generation. */
  canStartGeneration(): boolean {
    return !this.snapshot().exhausted;
  }

  /**
   * Whether one more provider call may be made. Deliberately looser than
   * canStartGeneration: a generation already under way is allowed to spend the
   * reserve rather than being abandoned halfway for the sake of a rounding
   * margin. Once the cap itself is reached, nothing further goes out.
   */
  canMakeCall(): boolean {
    this.rollOver();
    return this.state.spentUsd < this.options.capUsd;
  }

  /** Records what a call actually cost and persists the new total. */
  async record(usage: TokenUsage, rateMultiplier = 1): Promise<void> {
    this.rollOver();

    const cost = (estimateCostUsd(this.options.model, usage) ?? 0) * rateMultiplier;
    this.state.spentUsd += cost;
    this.state.usage = addUsage(this.state.usage, usage);

    await this.persist();
    this.options.onChange?.(this.snapshot());
  }

  /** Counts a finished generation, for the stats endpoint. */
  async countGeneration(): Promise<void> {
    this.rollOver();
    this.state.generations += 1;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const write = this.writing.then(async () => {
      const body = `${JSON.stringify(this.state, null, 2)}\n`;
      await mkdir(dirname(this.options.path), { recursive: true });
      // Written to one side and renamed, so a crash mid-write cannot leave a
      // half-file that reads as a smaller spend than actually happened.
      const temporary = `${this.options.path}.tmp`;
      await writeFile(temporary, body, 'utf8');
      await rename(temporary, this.options.path);
    });

    this.writing = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
}
