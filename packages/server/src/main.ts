/**
 * Process entry point.
 *
 * The only place that reads the environment, builds a provider and opens a
 * socket. Everything below this file is constructed from arguments, which is
 * what lets the tests build the same server without any of those things.
 */
import './env.js';
import { access } from 'node:fs/promises';
import { apiKeyFor, loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { Metrics } from './metrics.js';
import { BudgetedProvider, createProvider } from './providers/index.js';
import { DailyBudget } from './budget/daily-budget.js';
import { DailyBudgetLedger } from './budget/daily-ledger-adapter.js';
import { LiveAccess } from './budget/live-access.js';
import { ReplayStore } from './replay/store.js';
import { buildServer } from './server.js';
import { DEFAULT_BUDGET_STATE_PATH, REPLAY_DIRECTORY, WEB_DIST_DIRECTORY } from './paths.js';
import type { ServerContext } from './context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const replay = await ReplayStore.load(REPLAY_DIRECTORY);

  let provider: ServerContext['provider'];
  let dailyBudget: DailyBudget | undefined;
  let liveAccess: LiveAccess | undefined;

  if (config.liveGenerationEnabled) {
    if (!apiKeyFor(config)) {
      logger.error(
        { provider: config.LLM_PROVIDER },
        'DEMO_MODE is "live" but no API key is set for the selected provider. Refusing to start.',
      );
      process.exit(1);
    }

    const statePath = config.BUDGET_STATE_PATH.trim() || DEFAULT_BUDGET_STATE_PATH;

    try {
      dailyBudget = new DailyBudget({
        capUsd: config.DAILY_SPEND_CAP_USD,
        model: config.model,
        path: statePath,
        reserveUsd: config.LIVE_RESERVE_USD,
        onChange: (snapshot) =>
          logger.info(
            { spentUsd: snapshot.spentUsd, capUsd: snapshot.capUsd, utcDate: snapshot.utcDate },
            snapshot.exhausted ? 'daily budget exhausted, live generation is now off' : 'budget updated',
          ),
      });
    } catch (error) {
      // An unpriced model cannot be metered, and an unmetered provider must not
      // be reachable from a public demo.
      logger.error(
        { model: config.model },
        error instanceof Error ? error.message : 'Cannot meter the configured model.',
      );
      process.exit(1);
    }

    await dailyBudget.load();

    liveAccess = new LiveAccess({
      perAddressPerDay: config.LIVE_PER_IP_PER_DAY,
      maxConcurrent: config.LIVE_MAX_CONCURRENT,
    });

    // The budget is the outermost layer, so a retry cannot spend past it and
    // every call that happens is written to the ledger before its answer is used.
    const base = createProvider(config, {
      onRetry: ({ attempt, delayMs, error }) =>
        logger.warn({ attempt, delayMs, status: error.status }, 'retrying provider call'),
    });
    provider = new BudgetedProvider(base, new DailyBudgetLedger(dailyBudget));
  }

  const context: ServerContext = {
    config,
    logger,
    metrics: new Metrics(),
    replay,
    provider,
    dailyBudget,
    liveAccess,
    webRoot: (await exists(WEB_DIST_DIRECTORY)) ? WEB_DIST_DIRECTORY : undefined,
  };
  const app = await buildServer(context);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });

  logger.info(
    {
      demoMode: config.DEMO_MODE,
      provider: config.LLM_PROVIDER,
      model: config.model,
      replayTraces: replay.size,
      requestsPerMinute: config.LLM_REQUESTS_PER_MINUTE,
      ...(dailyBudget
        ? {
            dailyCapUsd: config.DAILY_SPEND_CAP_USD,
            spentTodayUsd: dailyBudget.snapshot().spentUsd,
            budgetStatePath: config.BUDGET_STATE_PATH.trim() || DEFAULT_BUDGET_STATE_PATH,
          }
        : {}),
    },
    config.liveGenerationEnabled
      ? `listening, live generation enabled inside a ${config.DAILY_SPEND_CAP_USD.toFixed(2)} daily budget`
      : 'listening in replay mode, no provider calls are possible',
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
