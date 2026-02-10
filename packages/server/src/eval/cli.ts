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
import { PROVIDER_NAMES, apiKeyFor, loadConfig, type ProviderName } from '../config.js';
import {
  BATCH_MULTIPLIER,
  BatchRunner,
  createProviderWithGuard,
  type LLMProvider,
  type SpendGuard,
} from '../providers/index.js';
import { runBaselineBatch } from './batch-baseline.js';
import { EVAL_CASES, balancedSample, casesByBand } from './fixtures.js';
import { OutcomeCache, cacheKey, configurationFor } from './cache.js';
import {
  MissingOutcomeError,
  ProviderUnavailableError,
  runEval,
  toOutcome,
  type RunTarget,
} from './runner.js';
import { describeOutcome, describeSummary, renderReport } from './report.js';
import type { EvalCase } from './types.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_OUT = join(REPO_ROOT, 'eval');
/**
 * Committed, not scratch. The cache is what makes the published table
 * reproducible by anyone who clones the repository: an offline run regenerates
 * the report from these outcomes without calling a provider.
 */
const CACHE_DIR = join(REPO_ROOT, 'eval', 'cache');

/**
 * Calls a single case tends to make. Measured rather than guessed: the agent is
 * asked to batch its tool calls, which brings a case down to roughly three or
 * four turns.
 */
const CALLS_PER_AGENT_CASE = 4;
const CALLS_PER_BASELINE_CASE = 1.3;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'agent,baseline' },
      provider: { type: 'string', default: '' },
      model: { type: 'string', default: '' },
      bands: { type: 'string', default: '' },
      case: { type: 'string', multiple: true, default: [] },
      limit: { type: 'string' },
      balanced: { type: 'string' },
      offline: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      batch: { type: 'boolean', default: false },
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

  const cases = selectCases(values.bands, values.case, values.limit, values.balanced);
  if (cases.length === 0) throw new Error('No cases matched the selection.');

  const providerNames = (values.provider.trim() === '' ? config.LLM_PROVIDER : values.provider)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean) as ProviderName[];

  for (const name of providerNames) {
    if (!PROVIDER_NAMES.includes(name)) {
      throw new Error(`Unknown provider "${name}". Use ${PROVIDER_NAMES.join(' or ')}.`);
    }
  }

  const cache = new OutcomeCache(CACHE_DIR);

  /** Config as it applies to one provider, honouring an explicit model override. */
  const configFor = (name: ProviderName) => {
    const overrides: Record<string, string> = { LLM_PROVIDER: name };
    if (values.model.trim() !== '' && providerNames.length === 1) {
      overrides.LLM_MODEL = values.model.trim();
    } else {
      // A model set for one provider must not leak onto another.
      overrides.LLM_MODEL = name === config.LLM_PROVIDER ? config.LLM_MODEL : '';
    }
    return loadConfig({ ...process.env, ...overrides });
  };

  const targets: RunTarget[] = [];
  const guards: Array<{ label: string; guard: SpendGuard }> = [];

  for (const name of providerNames) {
    const providerConfig = configFor(name);

    let provider: LLMProvider | undefined;
    if (!values.offline && !values['dry-run']) {
      if (!apiKeyFor(providerConfig)) {
        throw new Error(
          `No API key is set for the ${name} provider. Set it in .env, or run with --offline to use cached outcomes only.`,
        );
      }
      const created = createProviderWithGuard(providerConfig, {
        onRetry: ({ attempt, delayMs, error }) =>
          console.error(`  retry ${attempt} in ${delayMs}ms after ${error.status ?? 'error'}`),
      });
      provider = created.provider;
      if (created.guard) guards.push({ label: name, guard: created.guard });
    }

    for (const mode of modes) {
      targets.push({
        providerName: name,
        modelName: providerConfig.model,
        mode,
        ...(provider ? { provider } : {}),
      });
    }
  }

  if (values['dry-run']) {
    await reportDryRun(cases, targets, cache, config.AGENT_MAX_ITERATIONS, values.fresh);
    return;
  }

  // Baseline work is one independent completion per fixture, so it can go
  // through the batch endpoint at half price. Doing it as a pre-pass that fills
  // the cache keeps the runner itself unaware of batching: it simply finds the
  // outcomes already there.
  if (values.batch && !values.offline && !values.fresh) {
    await fillCacheFromBatch({
      cases,
      targets,
      cache,
      config,
      maxIterations: config.AGENT_MAX_ITERATIONS,
      guards,
    });
  }

  console.log(
    `Running ${cases.length} cases across ${targets.length} configuration${targets.length === 1 ? '' : 's'}` +
      (values.offline
        ? ' from cache only.'
        : `: ${targets.map((t) => `${t.providerName} ${t.modelName} ${t.mode}`).join(', ')}.`),
  );
  if (guards.length > 0) {
    console.log(
      `Spend cap: $${config.LLM_SPEND_CAP_USD.toFixed(2)}, enforced from reported token counts.`,
    );
  }
  console.log('');

  let currentMode = '';
  const report = await runEval({
    cases,
    targets,
    cache,
    maxIterations: config.AGENT_MAX_ITERATIONS,
    timeBudgetMs: config.AGENT_TIME_BUDGET_MS,
    fresh: values.fresh,
    onProgress: (event) => {
      const label = `${event.configuration.provider} ${event.configuration.mode}`;
      if (label !== currentMode) {
        currentMode = label;
        console.log(`${label}:`);
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
    console.log(`${entry.configuration.provider} ${entry.configuration.model} ${entry.configuration.mode}:`);
    console.log(describeSummary(entry.summary));
    console.log('');
  }

  for (const { label, guard } of guards) {
    const usage = guard.totalUsage;
    console.log(
      `${label}: spent $${guard.spentUsd.toFixed(4)} of the $${config.LLM_SPEND_CAP_USD.toFixed(2)} cap over ${guard.callCount} calls ` +
        `(${usage.inputTokens.toLocaleString()} input, ${(usage.cacheReadTokens ?? 0).toLocaleString()} cached reads, ` +
        `${(usage.cacheWriteTokens ?? 0).toLocaleString()} cache writes, ${usage.outputTokens.toLocaleString()} output).`,
    );
  }

  console.log(
    `${report.cacheHits} cached, ${report.providerCalls} provider calls made. Wrote ${join(values.out, 'results.json')} and results.md.`,
  );
}

function selectCases(
  bands: string,
  ids: readonly string[],
  limit: string | undefined,
  balanced: string | undefined,
): EvalCase[] {
  if (balanced) {
    const size = Number(balanced);
    if (!Number.isInteger(size) || size < 1) {
      throw new Error('--balanced must be a positive integer.');
    }
    const sample = balancedSample(size);
    console.log(
      `Balanced subset of ${sample.length} fixtures: ${sample.map((c) => c.id).join(', ')}`,
    );
    console.log('');
    return sample;
  }

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
 * Runs the baseline fixtures through the batch endpoint and writes the results
 * into the cache, so the ordinary runner finds them already done.
 *
 * Only Anthropic baseline targets qualify: the agent loop cannot be batched
 * without changing what it does, and Gemini's adapter has no batch path here.
 */
async function fillCacheFromBatch(options: {
  cases: readonly EvalCase[];
  targets: readonly RunTarget[];
  cache: OutcomeCache;
  config: ReturnType<typeof loadConfig>;
  maxIterations: number;
  guards: Array<{ label: string; guard: SpendGuard }>;
}): Promise<void> {
  const eligible = options.targets.filter(
    (target) => target.mode === 'baseline' && target.providerName === 'anthropic' && target.provider,
  );

  for (const target of eligible) {
    const configuration = configurationFor(
      target.providerName,
      target.modelName,
      target.mode,
      options.maxIterations,
    );

    const missing: EvalCase[] = [];
    for (const evalCase of options.cases) {
      const hit = await options.cache.get(
        cacheKey(evalCase.id, evalCase.description, configuration),
      );
      if (!hit) missing.push(evalCase);
    }

    if (missing.length === 0) {
      console.log('batch: every baseline fixture is already cached, nothing to submit.');
      continue;
    }

    const guard = options.guards.find((entry) => entry.label === 'anthropic')?.guard;
    guard?.assertHeadroom();

    console.log(
      `batch: submitting ${missing.length} baseline fixtures to the batch endpoint at half price.`,
    );

    const runner = new BatchRunner({
      apiKey: options.config.ANTHROPIC_API_KEY,
      model: target.modelName,
      promptCaching: options.config.LLM_PROMPT_CACHING,
      onProgress: ({ status, waitedMs }) =>
        console.log(`  batch ${status}, ${Math.round(waitedMs / 1000)}s elapsed`),
    });

    const results = await runBaselineBatch({
      cases: missing,
      runner,
      providerName: target.providerName,
      modelName: target.modelName,
      onRound: ({ round, items }) => console.log(`  round ${round}: ${items} items`),
    });

    let cached = 0;
    for (const [id, result] of results) {
      const evalCase = missing.find((candidate) => candidate.id === id);
      if (!evalCase) continue;

      // Batch tokens are billed at half, so they are counted at half.
      guard?.record(result.usage, BATCH_MULTIPLIER);

      if (result.failure?.reason === 'provider_error') continue;

      await options.cache.set(
        cacheKey(evalCase.id, evalCase.description, configuration),
        toOutcome(evalCase, 'baseline', result),
      );
      cached += 1;
    }

    console.log(`batch: ${cached} of ${missing.length} fixtures completed and cached.`);
    console.log('');
  }
}

/**
 * Says what a run would cost before it costs it. Cached cases are counted
 * separately from the ones that would actually reach the provider.
 */
async function reportDryRun(
  cases: readonly EvalCase[],
  targets: readonly RunTarget[],
  cache: OutcomeCache,
  maxIterations: number,
  fresh: boolean,
): Promise<void> {
  let cached = 0;
  let toRun = 0;
  let estimatedCalls = 0;

  console.log(`Cases selected:      ${cases.length}`);
  console.log('');

  for (const target of targets) {
    const configuration = configurationFor(
      target.providerName,
      target.modelName,
      target.mode,
      maxIterations,
    );

    let targetCached = 0;
    let targetToRun = 0;

    for (const evalCase of cases) {
      const hit = fresh
        ? undefined
        : await cache.get(cacheKey(evalCase.id, evalCase.description, configuration));
      if (hit) targetCached += 1;
      else targetToRun += 1;
    }

    const perCase = target.mode === 'agent' ? CALLS_PER_AGENT_CASE : CALLS_PER_BASELINE_CASE;
    cached += targetCached;
    toRun += targetToRun;
    estimatedCalls += targetToRun * perCase;

    console.log(
      `  ${`${target.providerName} ${target.modelName} ${target.mode}`.padEnd(46)} ` +
        `${String(targetCached).padStart(3)} cached, ${String(targetToRun).padStart(3)} to run, ` +
        `about ${String(Math.ceil(targetToRun * perCase)).padStart(4)} calls`,
    );
  }

  console.log('');
  console.log(`Generations total:   ${cases.length * targets.length}`);
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
  --balanced <n>    Run a subset of n fixtures spread proportionally across the
                    difficulty bands. Deterministic, and the chosen ids are
                    printed so a report can say exactly what was run.
  --offline         Use cached outcomes only. Fails if any are missing.
  --fresh           Ignore the cache and call the provider for every case.
  --batch           Send baseline fixtures through the batch endpoint at half
                    price. Anthropic only; the agent loop cannot be batched
                    without changing what it does.
  --dry-run         Report what would run, and how many provider calls that
                    implies, without sending anything.
  --out <dir>       Where to write results.json and results.md.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
