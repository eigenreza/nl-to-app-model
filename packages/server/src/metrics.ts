/**
 * In-process metrics.
 *
 * Enough to answer the questions an operator asks first (is it working, how
 * slow is it, how many tokens have gone out today) without adding a metrics
 * stack to a project this size. Everything is in memory and resets with the
 * process, which is stated on the endpoint rather than left to be discovered.
 */
import type { GenerationResult } from './generation/types.js';

/** Latency samples kept for percentiles. Bounded so memory cannot grow. */
const MAX_SAMPLES = 500;

export interface MetricsSnapshot {
  uptimeSeconds: number;
  requests: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  servedLive: number;
  servedFromReplay: number;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  tokens: { input: number; output: number; sinceUtcDate: string };
  failuresByReason: Record<string, number>;
  note: string;
}

export class Metrics {
  private startedAt = Date.now();
  private requests = 0;
  private succeeded = 0;
  private failed = 0;
  private servedLive = 0;
  private servedFromReplay = 0;
  private latencies: number[] = [];
  private failuresByReason: Record<string, number> = {};
  private tokenInput = 0;
  private tokenOutput = 0;
  private tokenDate = utcDate();

  record(result: GenerationResult, source: 'live' | 'replay'): void {
    this.requests += 1;
    if (result.ok) this.succeeded += 1;
    else this.failed += 1;

    if (source === 'live') this.servedLive += 1;
    else this.servedFromReplay += 1;

    if (result.failure) {
      this.failuresByReason[result.failure.reason] =
        (this.failuresByReason[result.failure.reason] ?? 0) + 1;
    }

    this.latencies.push(result.latencyMs);
    if (this.latencies.length > MAX_SAMPLES) this.latencies.shift();

    if (source === 'live') {
      this.rollTokenDay();
      this.tokenInput += result.usage.inputTokens;
      this.tokenOutput += result.usage.outputTokens;
    }
  }

  snapshot(): MetricsSnapshot {
    this.rollTokenDay();
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: this.requests,
      succeeded: this.succeeded,
      failed: this.failed,
      successRate: this.requests === 0 ? null : round(this.succeeded / this.requests, 3),
      servedLive: this.servedLive,
      servedFromReplay: this.servedFromReplay,
      latencyMsP50: percentile(this.latencies, 50),
      latencyMsP95: percentile(this.latencies, 95),
      tokens: { input: this.tokenInput, output: this.tokenOutput, sinceUtcDate: this.tokenDate },
      failuresByReason: { ...this.failuresByReason },
      note: `Counters are held in memory and reset when the process restarts. Latency percentiles use the last ${MAX_SAMPLES} requests.`,
    };
  }

  /** Token counters describe one UTC day, so they reset when the day turns. */
  private rollTokenDay(): void {
    const today = utcDate();
    if (today !== this.tokenDate) {
      this.tokenDate = today;
      this.tokenInput = 0;
      this.tokenOutput = 0;
    }
  }
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return Math.round(sorted[index] as number);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
