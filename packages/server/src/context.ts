import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import type { LLMProvider } from './providers/types.js';
import type { ReplayStore } from './replay/store.js';
import type { DailyBudget } from './budget/daily-budget.js';
import type { LiveAccess } from './budget/live-access.js';

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
  /**
   * The persisted daily spend ceiling. Present exactly when `provider` is,
   * because a provider that cannot be metered must not be reachable.
   */
  dailyBudget?: DailyBudget | undefined;
  /** Concurrency and per-address limits in front of the budget. */
  liveAccess?: LiveAccess | undefined;
  /**
   * Directory holding the built client, when the two are served together.
   * Undefined during development, where Vite serves the client itself.
   */
  webRoot?: string | undefined;
}
