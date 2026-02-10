/**
 * Builds replay fixtures from generations the eval already produced.
 *
 * The other recorder runs a live generation and costs a provider call. This one
 * costs nothing: every trace it writes was produced by the eval and is sitting
 * in the outcome cache. That matters beyond the money. The demo then shows
 * exactly the runs the published results were computed from, rather than a
 * separate set of generations that happened to go well.
 */
import '../env.js';
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerationMode } from '@nlam/shared';
import { loadConfig } from '../config.js';
import { REPLAY_DIRECTORY } from '../paths.js';
import { OutcomeCache, cacheKey, configurationFor } from '../eval/cache.js';
import { caseById } from '../eval/fixtures.js';
import type { ReplayTrace } from './store.js';

const CACHE_DIR = fileURLToPath(new URL('../../../../eval/cache', import.meta.url));

/**
 * What the demo offers a visitor.
 *
 * Chosen to show the range rather than only the flattering end: one
 * straightforward application, one that needs several metrics and a fixed
 * filter, one asking for a feature the schema cannot express, and one carrying
 * an injected instruction. The book tracker appears in both modes so the mode
 * toggle in the browser does something.
 */
const DEMO_SET: Array<{ caseId: string; mode: GenerationMode }> = [
  { caseId: 'book_tracker', mode: 'agent' },
  { caseId: 'book_tracker', mode: 'baseline' },
  { caseId: 'expense_tracker', mode: 'agent' },
  { caseId: 'issue_tracker', mode: 'agent' },
  { caseId: 'wants_chart', mode: 'agent' },
  { caseId: 'injection_ignore_instructions', mode: 'agent' },
];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'anthropic' },
      model: { type: 'string', default: '' },
      out: { type: 'string', default: REPLAY_DIRECTORY },
      case: { type: 'string', multiple: true, default: [] },
      mode: { type: 'string', default: 'agent' },
    },
    allowPositionals: false,
  });

  const config = loadConfig();
  const model =
    values.model.trim() ||
    (values.provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : config.model);

  const selection =
    values.case.length > 0
      ? values.case.map((caseId) => ({ caseId, mode: values.mode as GenerationMode }))
      : DEMO_SET;

  const cache = new OutcomeCache(CACHE_DIR);
  await mkdir(values.out, { recursive: true });

  let written = 0;
  const missing: string[] = [];

  for (const { caseId, mode } of selection) {
    const evalCase = caseById(caseId);
    if (!evalCase) throw new Error(`Unknown fixture id "${caseId}".`);

    const configuration = configurationFor(values.provider, model, mode, config.AGENT_MAX_ITERATIONS);
    const outcome = await cache.get(cacheKey(caseId, evalCase.description, configuration));

    if (!outcome) {
      missing.push(`${caseId} (${mode})`);
      continue;
    }

    if (!outcome.ok) {
      console.log(`  skipped ${caseId} (${mode}): the generation did not succeed.`);
      continue;
    }

    const trace: ReplayTrace = {
      id: caseId,
      description: evalCase.description,
      mode,
      recordedAt: new Date().toISOString(),
      result: outcome.result,
    };

    const path = join(values.out, `${caseId}.${mode}.json`);
    await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
    console.log(`  wrote ${caseId}.${mode}.json`);
    written += 1;
  }

  if (missing.length > 0) {
    console.error('');
    console.error(`No cached generation for: ${missing.join(', ')}.`);
    console.error(`Run the eval for ${values.provider} ${model} first.`);
    process.exit(1);
  }

  console.log('');
  console.log(`${written} replay fixtures written from cached generations. No provider was called.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
