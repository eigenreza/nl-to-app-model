import { fileURLToPath } from 'node:url';

/**
 * Filesystem locations resolved relative to this module rather than to the
 * working directory, so the server and the recorder agree on where fixtures
 * live however they are started.
 */
export const REPLAY_DIRECTORY = fileURLToPath(new URL('../fixtures/replay', import.meta.url));
