/**
 * Who may start a live generation, and how many at once.
 *
 * The daily budget is the authoritative guard: it is persisted and it is what
 * actually bounds spend. These two are cheaper protections in front of it, so
 * that one visitor cannot consume the whole day's allowance in a minute, and
 * so that a burst of arrivals queues at one rather than all reaching the
 * provider together.
 *
 * Both are in memory. That is a deliberate limit rather than an oversight: they
 * reset on restart, and the budget behind them does not.
 */

/** Bounded so a stream of distinct addresses cannot grow this without limit. */
const MAX_TRACKED_ADDRESSES = 10_000;

export interface LiveAccessOptions {
  /** Live generations one address may start per UTC day. */
  perAddressPerDay: number;
  /** Live generations that may be in flight at once. */
  maxConcurrent: number;
  now?: () => Date;
}

export type LiveRefusal = 'rate_limited' | 'busy';

export class LiveAccess {
  private readonly counts = new Map<string, number>();
  private utcDate: string;
  private inFlight = 0;
  private readonly now: () => Date;

  constructor(private readonly options: LiveAccessOptions) {
    this.now = options.now ?? (() => new Date());
    this.utcDate = this.today();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollOver(): void {
    const today = this.today();
    if (this.utcDate !== today) {
      this.utcDate = today;
      this.counts.clear();
    }
  }

  /** How many live generations this address has left today. */
  remainingFor(address: string): number {
    this.rollOver();
    return Math.max(0, this.options.perAddressPerDay - (this.counts.get(address) ?? 0));
  }

  get concurrentInFlight(): number {
    return this.inFlight;
  }

  /**
   * Claims a slot for one live generation. Returns a release function, or the
   * reason it was refused. The count is spent on claiming rather than on
   * finishing, so an abandoned request still costs the caller its allowance.
   */
  claim(address: string): { release: () => void } | { refused: LiveRefusal } {
    this.rollOver();

    if (this.inFlight >= this.options.maxConcurrent) return { refused: 'busy' };
    if (this.remainingFor(address) <= 0) return { refused: 'rate_limited' };

    if (this.counts.size >= MAX_TRACKED_ADDRESSES && !this.counts.has(address)) {
      // Rather than grow without bound, forget the oldest tracked address.
      const oldest = this.counts.keys().next();
      if (!oldest.done) this.counts.delete(oldest.value);
    }

    this.counts.set(address, (this.counts.get(address) ?? 0) + 1);
    this.inFlight += 1;

    let released = false;
    return {
      release: () => {
        if (released) return; // Releasing twice must not free someone else's slot.
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
      },
    };
  }
}
