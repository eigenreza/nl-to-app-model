/**
 * Eval command line.
 *
 * Three things it does that a plainer runner would not, all of them because
 * this suite runs inside a free-tier quota:
 *
 *   --dry-run  says exactly how many provider calls a run would make before
 *              making any of them,
 *   --offline  regenerates the report from cached outcomes with no provider at
 *              all, which is how anyone else reproduces the published table,
 *   caching    is on by default, so a rerun after an unrelated change is free
 *              and a rerun after a prompt change correctly is not.
 */
import '../env.js';
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { GenerationMode } from '@nlam/shared';
import { apiKeyFor, loadConfig } from '../config.js';
import { createProvider } from '../providers/index.js';
import { EVAL_CASES, casesByBand } from './fixtures.js';
import { OutcomeCache, cacheKey, configurationFor } from './cache.js';
import { MissingOutcomeError, ProviderUnavailableError, runEval } from './runner.js';
import { describeOutcome, describeSummary, renderReport } from './report.js';
import type { EvalCase } from './types.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_OUT = join(REPO_ROOT, 'eval');
const CACHE_DIR = join(REPO_ROOT, '.eval-cache');

/**
 * Calls a single case tends to make, measured against gemini-3.6-flash rather
 * than guessed: the model issues one tool call per turn, so an agent case costs
 * roughly ten.
 */
const CALLS_PER_AGENT_CASE = 10;
const CALLS_PER_BASELINE_CASE = 1.3;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'agent,baseline' },
      bands: { type: 'string', default: '' },
      case: { type: 'string', multiple: true, default: [] },
      limit: { type: 'string' },
      offline: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string', default: DEFAULT_OUT },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const modes = values.mode
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean) as GenerationMode[];

  for (const mode of modes) {
    if (mode !== 'agent' && mode !== 'baseline') {
      throw new Error(`Unknown mode "${mode}". Use "agent", "baseline" or both.`);
    }
  }

  const cases = selectCases(values.bands, values.case, values.limit);
  if (cases.length === 0) throw new Error('No cases matched the selection.');

  const cache = new OutcomeCache(CACHE_DIR);

  if (values['dry-run']) {
    await reportDryRun(
      cases,
      modes,
      cache,
      config.LLM_PROVIDER,
      config.model,
      config.AGENT_MAX_ITERATIONS,
      values.fresh,
    );
    return;
  }

  const provider = values.offline
    ? undefined
    : (() => {
        if (!apiKeyFor(config)) {
          throw new Error(
            `No API key is set for the ${config.LLM_PROVIDER} provider. Set it in .env, or run with --offline to use cached outcomes only.`,
          );
        }
        return createProvider(config, {
          onRetry: ({ attempt, delayMs, error }) =>
            console.error(`  retry ${attempt} in ${delayMs}ms after ${error.status ?? 'error'}`),
        });
      })();

  console.log(
    `Running ${cases.length} cases in ${modes.join(' and ')} mode${modes.length > 1 ? 's' : ''}` +
      (values.offline ? ' from cache only.' : ` against ${config.LLM_PROVIDER} ${config.model}.`),
  );
  console.log('');

  let currentMode = '';
  const report = await runEval({
    cases,
    modes,
    cache,
    ...(provider ? { provider } : {}),
    providerName: config.LLM_PROVIDER,
    modelName: config.model,
    maxIterations: config.AGENT_MAX_ITERATIONS,
    timeBudgetMs: config.AGENT_TIME_BUDGET_MS,
    fresh: values.fresh,
    onProgress: (event) => {
      if (event.configuration.mode !== currentMode) {
        currentMode = event.configuration.mode;
        console.log(`${currentMode}:`);
      }
      console.log(`  ${describeOutcome(event.outcome, event.source)}`);
    },
  }).catch((error: unknown) => {
    if (error instanceof ProviderUnavailableError) {
      throw new Error(
        `${error.message}
If this is a daily free-tier quota, wait for it to reset and run the same command again.`,
      );
    }
    if (error instanceof MissingOutcomeError) {
      throw new Error(
        `${error.message}\nRun without --offline to produce it, or restrict the run with --case or --bands.`,
      );
    }
    throw error;
  });

  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(values.out, 'results.md'), renderReport(report), 'utf8');

  console.log('');
  for (const entry of report.configurations) {
    console.log(`${entry.configuration.mode}:`);
    console.log(describeSummary(entry.summary));
    console.log('');
  }
  console.log(
    `${report.cacheHits} cached, ${report.providerCalls} provider calls made. Wrote ${join(values.out, 'results.json')} and results.md.`,
  );
}

function selectCases(bands: string, ids: readonly string[], limit: string | undefined): EvalCase[] {
  let selected =
    ids.length > 0
      ? EVAL_CASES.filter((evalCase) => ids.includes(evalCase.id))
      : casesByBand(
          bands
            .split(',')
            .map((band) => band.trim())
            .filter(Boolean),
        );

  if (ids.length > 0) {
    const missing = ids.filter((id) => !EVAL_CASES.some((evalCase) => evalCase.id === id));
    if (missing.length > 0) throw new Error(`Unknown case ids: ${missing.join(', ')}`);
  }

  if (limit) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1)
      throw new Error('--limit must be a positive integer.');
    selected = selected.slice(0, count);
  }

  return selected;
}

/**
 * Says what a run would cost before it costs it. Cached cases are counted
 * separately from the ones that would actually reach the provider.
 */
async function reportDryRun(
  cases: readonly EvalCase[],
  modes: readonly GenerationMode[],
  cache: OutcomeCache,
  providerName: string,
  modelName: string,
  maxIterations: number,
  fresh: boolean,
): Promise<void> {
  let cached = 0;
  let toRun = 0;
  let estimatedCalls = 0;

  for (const mode of modes) {
    const configuration = configurationFor(providerName, modelName, mode, maxIterations);
    for (const evalCase of cases) {
      const hit = fresh
        ? undefined
        : await cache.get(cacheKey(evalCase.id, evalCase.description, configuration));
      if (hit) {
        cached += 1;
      } else {
        toRun += 1;
        estimatedCalls += mode === 'agent' ? CALLS_PER_AGENT_CASE : CALLS_PER_BASELINE_CASE;
      }
    }
  }

  console.log(`Cases selected:      ${cases.length}`);
  console.log(`Modes:               ${modes.join(', ')}`);
  console.log(`Generations total:   ${cases.length * modes.length}`);
  console.log(`Already cached:      ${cached}`);
  console.log(`Would run live:      ${toRun}`);
  console.log(`Estimated provider calls: about ${Math.ceil(estimatedCalls)}`);
  console.log('');
  console.log('Nothing was sent. Drop --dry-run to run it.');
}

function printHelp(): void {
  console.log(`Usage: npm run eval -- [options]

  --mode <list>     Comma separated: agent, baseline. Default both.
  --bands <list>    Restrict to difficulty bands: simple, moderate, awkward,
                    out_of_scope, adversarial. Default all.
  --case <id>       Run one case. Repeatable.
  --limit <n>       Take only the first n selected cases.
  --offline         Use cached outcomes only. Fails if any are missing.
  --fresh           Ignore the cache and call the provider for every case.
  --dry-run         Report what would run, and how many provider calls that
                    implies, without sending anything.
  --out <dir>       Where to write results.json and results.md.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
