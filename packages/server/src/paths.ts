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
