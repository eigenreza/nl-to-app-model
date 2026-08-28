/**
 * Logging.
 *
 * One structured line per generation, carrying the fields you would actually
 * want when something goes wrong in production: which request, which provider
 * and model, how many iterations, how long, how many tokens, and what the
 * outcome was. The prompt itself is not logged, only a hash of it, so the log
 * can be kept and shared without carrying user text around.
 */
import { createHash } from 'node:crypto';
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(config: Config): Logger {
  const options = {
    level: config.LOG_LEVEL,
    base: { service: 'nl-to-app-model' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-demo-token"]', 'apiKey'],
      censor: '[redacted]',
    },
  };

  if (config.NODE_ENV !== 'development') return pino(options);

  try {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
    });
  } catch {
    // pino-pretty is a development dependency, so it is absent from a
    // production install. Asking for it there throws while the transport is
    // being resolved, which took the whole process down on first start: the
    // deployment defaults to NODE_ENV=development unless the host says
    // otherwise, and most hosts do not. Readable output is a convenience, and
    // a convenience must never be the reason a server refuses to run.
    return pino(options);
  }
}

/** Short, stable identifier for a prompt, safe to keep in logs indefinitely. */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt.trim().toLowerCase()).digest('hex').slice(0, 16);
}
