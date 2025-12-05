import { describe, expect, it } from 'vitest';
import type { GenerationResult } from '@nlam/shared';
import { Metrics, percentile } from './metrics.js';
import { ReplayStore, normaliseDescription, type ReplayTrace } from './replay/store.js';

function result(overrides: Partial<GenerationResult> = {}): GenerationResult {
  return {
    ok: true,
    mode: 'agent',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    applicationModel: null,
    validFirstTry: true,
    iterations: 4,
    steps: [],
    usage: { inputTokens: 1000, outputTokens: 200 },
    latencyMs: 1200,
    failure: null,
    warnings: [],
    ...overrides,
  };
}

describe('percentile', () => {
  it('returns null for no samples', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('picks the nearest rank', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile([42], 95)).toBe(42);
  });
});

describe('Metrics', () => {
  it('counts outcomes and separates live from replayed traffic', () => {
    const metrics = new Metrics();
    metrics.record(result(), 'live');
    metrics.record(
      result({
        ok: false,
        failure: { reason: 'iteration_cap', message: 'x', outstandingIssues: [] },
      }),
      'live',
    );
    metrics.record(result(), 'replay');

    const snapshot = metrics.snapshot();
    expect(snapshot.requests).toBe(3);
    expect(snapshot.succeeded).toBe(2);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.successRate).toBeCloseTo(0.667, 2);
    expect(snapshot.servedLive).toBe(2);
    expect(snapshot.servedFromReplay).toBe(1);
    expect(snapshot.failuresByReason).toEqual({ iteration_cap: 1 });
  });

  it('charges tokens only to live traffic', () => {
    const metrics = new Metrics();
    metrics.record(result(), 'replay');
    expect(metrics.snapshot().tokens).toMatchObject({ input: 0, output: 0 });

    metrics.record(result(), 'live');
    expect(metrics.snapshot().tokens).toMatchObject({ input: 1000, output: 200 });
  });

  it('reports no success rate before anything has been served', () => {
    expect(new Metrics().snapshot().successRate).toBeNull();
  });
});

describe('ReplayStore', () => {
  const trace = (description: string): ReplayTrace => ({
    id: 'demo',
    description,
    mode: 'agent',
    recordedAt: '2025-11-02T10:00:00.000Z',
    result: result(),
  });

  it('treats case, spacing and a trailing full stop as the same prompt', () => {
    expect(normaliseDescription('  A Book   Tracker. ')).toBe('a book tracker');

    const store = new ReplayStore([trace('a book tracker')]);
    expect(store.find('A Book Tracker.', 'agent')).toBeDefined();
    expect(store.find('a book tracker', 'baseline')).toBeUndefined();
  });

  it('keys traces by mode as well as description', () => {
    const store = new ReplayStore([trace('a book tracker')]);
    store.add({
      ...trace('a book tracker'),
      mode: 'baseline',
      result: result({ mode: 'baseline' }),
    });

    expect(store.size).toBe(2);
    expect(store.find('a book tracker', 'baseline')?.result.mode).toBe('baseline');
  });

  it('starts empty when there are no fixtures on disk', async () => {
    const store = await ReplayStore.load('./does-not-exist');
    expect(store.size).toBe(0);
    expect(store.catalogue()).toEqual([]);
  });
});
