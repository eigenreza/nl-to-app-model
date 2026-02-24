import { fileURLToPath } from 'node:url';

/**
 * Filesystem locations resolved relative to this module rather than to the
 * working directory, so the server and the recorder agree on where fixtures
 * live however they are started.
 */
export const REPLAY_DIRECTORY = fileURLToPath(new URL('../fixtures/replay', import.meta.url));

/**
 * The built client, when the two are deployed together as one container. Absent
 * during development, where Vite serves the client and proxies the API.
 */
export const WEB_DIST_DIRECTORY = fileURLToPath(new URL('../../web/dist', import.meta.url));

/**
 * Default location of the daily spend ledger. Inside the repository so a local
 * run works with no configuration; a deployment should point
 * BUDGET_STATE_PATH at storage that survives a restart.
 */
export const DEFAULT_BUDGET_STATE_PATH = fileURLToPath(
  new URL('../../../.local/budget-state.json', import.meta.url),
);
