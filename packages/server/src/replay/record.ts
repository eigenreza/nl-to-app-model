/**
 * Records a live generation as a replay fixture.
 *
 * This is the only path that deliberately spends provider quota outside the
 * eval runner, so it is explicit about it: one description per invocation, the
 * trace written verbatim, and a refusal to overwrite an existing fixture unless
 * asked. What it writes is exactly what the server later serves, which is what
 * makes a replayed demo the real thing rather than a mock of it.
 */
import '../env.js';
import { parseArgs } from 'node:util';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerationMode } from '@nlam/shared';
import { apiKeyFor, loadConfig } from '../config.js';
import { createProvider } from '../providers/index.js';
import { runLive } from '../generation/run.js';
import { REPLAY_DIRECTORY } from '../paths.js';
import type { ReplayTrace } from './store.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      id: { type: 'string' },
      mode: { type: 'string', default: 'agent' },
      force: { type: 'boolean', default: false },
      out: { type: 'string', default: REPLAY_DIRECTORY },
    },
    allowPositionals: true,
  });

  const description = positionals.join(' ').trim();
  if (description === '') {
    console.error(
      'Usage: npm run record --workspace=@nlam/server -- [--id <slug>] [--mode agent|baseline] [--force] "<description>"',
    );
    process.exit(1);
  }

  const mode = values.mode as GenerationMode;
  if (mode !== 'agent' && mode !== 'baseline') {
    throw new Error(`Unknown mode "${values.mode}". Use "agent" or "baseline".`);
  }

  const config = loadConfig();
  if (!apiKeyFor(config)) {
    throw new Error(`No API key is set for the ${config.LLM_PROVIDER} provider. Set it in .env.`);
  }

  const id = values.id ?? slugify(description);
  const path = join(values.out, `${id}.${mode}.json`);

  if (!values.force && (await exists(path))) {
    throw new Error(`${path} already exists. Pass --force to overwrite it.`);
  }

  const provider = createProvider(config, {
    onRetry: ({ attempt, delayMs, error }) =>
      console.error(`  retry ${attempt} in ${delayMs}ms after ${error.status ?? 'error'}`),
  });

  console.log(`Recording "${description}" in ${mode} mode against ${config.model}.`);

  const { result } = await runLive(provider, {
    description,
    mode,
    maxIterations: config.AGENT_MAX_ITERATIONS,
    timeBudgetMs: config.AGENT_TIME_BUDGET_MS,
    onStep: (step) => console.log(`  ${step.ok ? '+' : '!'} ${step.label}`),
  });

  if (!result.ok) {
    console.error('');
    console.error(`The generation did not succeed: ${result.failure?.message ?? 'unknown reason'}`);
    console.error('Nothing was written. Adjust the description or rerun.');
    process.exit(1);
  }

  const trace: ReplayTrace = {
    id,
    description,
    mode,
    recordedAt: new Date().toISOString(),
    result,
  };

  await mkdir(values.out, { recursive: true });
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(
    `Wrote ${path} (${result.iterations} provider calls, ${result.usage.inputTokens + result.usage.outputTokens} tokens).`,
  );
}

function slugify(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .slice(0, 4)
    .join('_');
  return slug === '' ? 'trace' : slug;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
