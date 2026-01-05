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
import { createProvider } from './providers/index.js';
import { ReplayStore } from './replay/store.js';
import { buildServer } from './server.js';
import { REPLAY_DIRECTORY, WEB_DIST_DIRECTORY } from './paths.js';
import type { ServerContext } from './context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const replay = await ReplayStore.load(REPLAY_DIRECTORY);

  let provider: ServerContext['provider'];
  if (config.liveGenerationEnabled) {
    if (!apiKeyFor(config)) {
      logger.error(
        { provider: config.LLM_PROVIDER },
        'DEMO_MODE is "live" but no API key is set for the selected provider. Refusing to start.',
      );
      process.exit(1);
    }
    provider = createProvider(config, {
      onRetry: ({ attempt, delayMs, error }) =>
        logger.warn({ attempt, delayMs, status: error.status }, 'retrying provider call'),
    });
  }

  const context: ServerContext = {
    config,
    logger,
    metrics: new Metrics(),
    replay,
    provider,
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
    },
    config.liveGenerationEnabled
      ? 'listening, live generation enabled'
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
