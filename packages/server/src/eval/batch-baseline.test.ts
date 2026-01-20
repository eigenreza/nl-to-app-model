import { describe, expect, it } from 'vitest';
import { EXAMPLE_MODELS } from '@nlam/shared';
import type { BatchItem, BatchOutcome, BatchRunner } from '../providers/batch.js';
import { runBaselineBatch } from './batch-baseline.js';
import type { EvalCase } from './types.js';

/** A model document as a generator would return it, without a schemaVersion. */
function candidateJson(overrides: Record<string, unknown> = {}): string {
  const { schemaVersion: _ignored, ...rest } = EXAMPLE_MODELS.contact_list;
  return JSON.stringify({ ...rest, ...overrides });
}

const BROKEN = candidateJson({ components: [{ id: 'x', type: 'table', entityId: 'nope' }] });

const cases: EvalCase[] = [
  { id: 'good', band: 'simple', description: 'a contact list' },
  { id: 'needs_repair', band: 'simple', description: 'another contact list' },
];

/**
 * Stands in for the batch endpoint. Each round is scripted by case id, so a
 * test can say "this one fails first and succeeds on repair" directly.
 */
function fakeRunner(rounds: Array<Record<string, string | Error>>): {
  runner: BatchRunner;
  submitted: BatchItem[][];
} {
  const submitted: BatchItem[][] = [];
  let round = 0;

  const runner = {
    async run(items: readonly BatchItem[]): Promise<BatchOutcome[]> {
      submitted.push([...items]);
      const script = rounds[round] ?? {};
      round += 1;

      return items.map((item) => {
        const scripted = script[item.id];
        if (scripted instanceof Error) return { id: item.id, ok: false as const, error: scripted };
        return {
          id: item.id,
          ok: true as const,
          response: {
            text: scripted ?? '',
            toolCalls: [],
            usage: { inputTokens: 1000, outputTokens: 500 },
            finishReason: 'end_turn',
            latencyMs: 0,
          },
        };
      });
    },
  } as unknown as BatchRunner;

  return { runner, submitted };
}

function run(rounds: Array<Record<string, string | Error>>, evalCases = cases) {
  const { runner, submitted } = fakeRunner(rounds);
  return runBaselineBatch({
    cases: evalCases,
    runner,
    providerName: 'anthropic',
    modelName: 'claude-haiku-4-5-20251001',
  }).then((results) => ({ results, submitted }));
}

describe('runBaselineBatch', () => {
  it('accepts every fixture that validated first time and submits no repair round', async () => {
    const { results, submitted } = await run([
      { good: candidateJson(), needs_repair: candidateJson() },
    ]);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toHaveLength(2);

    for (const id of ['good', 'needs_repair']) {
      const result = results.get(id)!;
      expect(result.ok).toBe(true);
      expect(result.validFirstTry).toBe(true);
      expect(result.iterations).toBe(1);
      expect(result.applicationModel?.app.name).toBe('Contact list');
    }
  });

  it('sends only the failures into the repair round', async () => {
    const { results, submitted } = await run([
      { good: candidateJson(), needs_repair: BROKEN },
      { needs_repair: candidateJson() },
    ]);

    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.map((item) => item.id)).toEqual(['needs_repair']);

    expect(results.get('good')?.validFirstTry).toBe(true);
    const repaired = results.get('needs_repair')!;
    expect(repaired.ok).toBe(true);
    expect(repaired.validFirstTry).toBe(false);
    expect(repaired.iterations).toBe(2);
    expect(repaired.steps.map((step) => step.kind)).toEqual(['draft', 'repair']);
  });

  it('puts the validation errors into the repair prompt', async () => {
    const { submitted } = await run([
      { good: candidateJson(), needs_repair: BROKEN },
      { needs_repair: candidateJson() },
    ]);

    const repairMessages = submitted[1]?.[0]?.request.messages ?? [];
    const last = repairMessages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.role === 'user' && last.content).toContain('No entity with id "nope"');
  });

  it('gives up on a fixture that is still invalid after the repair', async () => {
    const { results } = await run([
      { good: candidateJson(), needs_repair: BROKEN },
      { needs_repair: BROKEN },
    ]);

    const failed = results.get('needs_repair')!;
    expect(failed.ok).toBe(false);
    expect(failed.failure?.reason).toBe('invalid_model');
    expect(failed.failure?.outstandingIssues[0]?.code).toBe('unknown_entity');
  });

  it('records an unreadable response as a fatal outcome rather than repairing it', async () => {
    const { results, submitted } = await run([
      { good: candidateJson(), needs_repair: 'I would rather not.' },
    ]);

    expect(submitted).toHaveLength(1); // Nothing to repair: it was never a document.
    expect(results.get('needs_repair')?.failure?.reason).toBe('unparseable_output');
  });

  it('reports a batch item failure as a provider error', async () => {
    const { results } = await run([
      { good: candidateJson(), needs_repair: new Error('batch item errored: overloaded') },
    ]);

    const failed = results.get('needs_repair')!;
    expect(failed.ok).toBe(false);
    expect(failed.failure?.reason).toBe('provider_error');
    expect(failed.failure?.message).toContain('overloaded');
  });

  it('accumulates usage across both rounds', async () => {
    const { results } = await run([
      { good: candidateJson(), needs_repair: BROKEN },
      { needs_repair: candidateJson() },
    ]);

    expect(results.get('good')?.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(results.get('needs_repair')?.usage).toEqual({ inputTokens: 2000, outputTokens: 1000 });
  });

  it('labels every result as baseline mode with the provider it ran against', async () => {
    const { results } = await run([{ good: candidateJson(), needs_repair: candidateJson() }]);
    const result = results.get('good')!;

    expect(result.mode).toBe('baseline');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
  });
});
