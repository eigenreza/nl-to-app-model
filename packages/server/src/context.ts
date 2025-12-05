import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import type { LLMProvider } from './providers/types.js';
import type { ReplayStore } from './replay/store.js';

/**
 * Everything the routes need, assembled once at startup and passed in.
 *
 * `provider` is deliberately optional. In replay mode the process never builds
 * one, so reaching a provider is not something a route can do by accident: it
 * is a value that is not there.
 */
export interface ServerContext {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  replay: ReplayStore;
  provider: LLMProvider | undefined;
}
