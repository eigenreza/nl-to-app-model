/**
 * Environment file loading.
 *
 * `.env` lives at the repository root, but commands run from several working
 * directories: the root for `npm run dev`, the package for a workspace script,
 * and an image root in a container. Loading purely from the working directory
 * means the same command finds the key sometimes and not others, which is a
 * confusing way to discover that a run was never configured.
 *
 * So both locations are tried, nearest first. Real environment variables always
 * win, because dotenv does not overwrite what is already set, which is what a
 * container or a CI runner relies on.
 */
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/** Repository root, resolved from this module rather than from the caller. */
const ROOT_ENV = fileURLToPath(new URL('../../../.env', import.meta.url));

config({ quiet: true });
config({ path: ROOT_ENV, quiet: true });
