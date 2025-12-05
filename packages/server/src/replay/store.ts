/**
 * Replay.
 *
 * A public demo of this project has to be able to run indefinitely without
 * anyone paying for it, and it has to survive being linked somewhere busy. In
 * replay mode the server answers from traces recorded earlier and cannot reach
 * a provider at all, so an anonymous visitor gets the real thing (the same
 * model, the same trace, the same rendered application) at zero marginal cost
 * and with no way to run up a bill.
 *
 * Traces are ordinary JSON files. They are produced by the recorder, which
 * runs a live generation once and writes the result verbatim.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ApplicationModelSchema } from '@nlam/shared';
import type { GenerationResult } from '../generation/types.js';

export interface ReplayTrace {
  id: string;
  description: string;
  mode: GenerationResult['mode'];
  recordedAt: string;
  result: GenerationResult;
}

/**
 * Fixtures are files on disk, so they are validated on load rather than
 * trusted. The application model inside a trace goes through the same schema
 * everything else does, which means a fixture recorded against an older schema
 * fails loudly at startup instead of reaching the browser.
 */
const UsageSchema = z.object({ inputTokens: z.number(), outputTokens: z.number() });

const IssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});

const StepSchema = z.object({
  index: z.number(),
  kind: z.enum(['draft', 'repair', 'plan', 'tool', 'finalize']),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
  issues: z.array(IssueSchema).optional(),
  usage: UsageSchema,
  latencyMs: z.number(),
});

const ResultSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(['baseline', 'agent']),
  provider: z.string(),
  model: z.string(),
  applicationModel: z.union([ApplicationModelSchema, z.null()]),
  validFirstTry: z.boolean(),
  iterations: z.number(),
  steps: z.array(StepSchema),
  usage: UsageSchema,
  latencyMs: z.number(),
  failure: z
    .object({
      reason: z.enum([
        'iteration_cap',
        'time_budget',
        'unparseable_output',
        'invalid_model',
        'provider_error',
        'empty_output',
      ]),
      message: z.string(),
      outstandingIssues: z.array(IssueSchema),
    })
    .nullable(),
  warnings: z.array(IssueSchema),
});

const TraceFileSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  mode: z.enum(['baseline', 'agent']),
  recordedAt: z.string().min(1),
  result: ResultSchema,
});

/** Prompts differing only in case, spacing or a trailing full stop are the same prompt. */
export function normaliseDescription(description: string): string {
  return description
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
}

export class ReplayStore {
  private readonly byKey = new Map<string, ReplayTrace>();

  constructor(traces: readonly ReplayTrace[] = []) {
    for (const trace of traces) this.add(trace);
  }

  static async load(directory: string): Promise<ReplayStore> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      // No fixtures yet is a normal state, not an error. The routes report an
      // empty catalogue rather than failing to start.
      return new ReplayStore();
    }

    const traces: ReplayTrace[] = [];
    for (const name of names.filter((file) => file.endsWith('.json')).sort()) {
      const raw = await readFile(join(directory, name), 'utf8');
      const parsed = TraceFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(`Replay fixture ${name} is malformed: ${parsed.error.issues[0]?.message}`);
      }
      traces.push(parsed.data);
    }

    return new ReplayStore(traces);
  }

  get size(): number {
    return this.byKey.size;
  }

  add(trace: ReplayTrace): void {
    this.byKey.set(keyFor(trace.description, trace.mode), trace);
  }

  find(description: string, mode: GenerationResult['mode']): ReplayTrace | undefined {
    return this.byKey.get(keyFor(description, mode));
  }

  /** The prompts a replay-only deployment can answer, for the browser to offer. */
  catalogue(): Array<{ id: string; description: string; mode: GenerationResult['mode'] }> {
    return [...this.byKey.values()]
      .map(({ id, description, mode }) => ({ id, description, mode }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

function keyFor(description: string, mode: string): string {
  return `${mode}::${normaliseDescription(description)}`;
}
