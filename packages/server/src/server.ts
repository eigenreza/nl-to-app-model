/**
 * Assembles the HTTP server.
 *
 * Kept separate from the process entry point so that tests can build a server
 * with a scripted provider and an in-memory replay store and drive it through
 * fastify's inject(), without opening a socket or reaching a network.
 */
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { ServerContext } from './context.js';
import { registerGenerateRoutes } from './routes/generate.js';
import { registerMetaRoutes } from './routes/meta.js';

export async function buildServer(context: ServerContext): Promise<FastifyInstance> {
  // A provider that can be reached but not metered is the one configuration
  // this must never assemble. Refusing here turns a silent "live generation
  // quietly never works" into a loud failure at startup.
  if (context.provider && !context.dailyBudget) {
    throw new Error(
      'A provider was supplied without a daily budget. Live generation must be metered, so the server will not start in that state.',
    );
  }

  const app = Fastify({
    loggerInstance: context.logger as FastifyBaseLogger,
    // Requests carry a description and nothing else, so a small ceiling is
    // enough and keeps an oversized body from being buffered at all.
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  if (context.config.CORS_ORIGIN) {
    await app.register(cors, {
      origin: context.config.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
      methods: ['GET', 'POST'],
    });
  }

  await app.register(rateLimit, {
    max: context.config.RATE_LIMIT_MAX,
    timeWindow: context.config.RATE_LIMIT_WINDOW_MS,
    // Health checks and the catalogue are cheap and are polled by the browser.
    allowList: () => false,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, limit) => ({
      statusCode: 429,
      error: {
        code: 'rate_limited',
        message: `Too many requests. The limit is ${limit.max} per window. Try again in ${Math.ceil(limit.ttl / 1000)} seconds.`,
      },
    }),
  });

  if (context.webRoot) {
    // wildcard:true serves whatever is on disk at request time. The alternative
    // snapshots the directory when the plugin is registered, which means an
    // asset written after startup is silently answered by the SPA fallback
    // below, as text/html, and the page loads blank with only a MIME type
    // complaint in the console. A missing file still reaches the not-found
    // handler, so the fallback keeps working.
    await app.register(fastifyStatic, { root: context.webRoot, wildcard: true });
  }

  app.setNotFoundHandler(async (request, reply) => {
    // With the client served from the same process, a navigation to a route the
    // client handles should get the shell. A request for a file that is not
    // there should not: answering a missing script with HTML is how a broken
    // build turns into a blank page and a MIME type complaint instead of a 404,
    // which is a considerably worse afternoon.
    if (context.webRoot && request.method === 'GET' && isClientNavigation(request.url)) {
      return reply.sendFile('index.html');
    }

    return reply.status(404).send({
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}.` },
    });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled request error');

    // Plugins that already built a body in our envelope shape keep it, so the
    // rate limiter's explanation reaches the caller intact.
    const provided = (error as unknown as { error?: { code?: string; message?: string } }).error;
    if (provided?.code && provided.message) {
      return reply.status(status).send({ error: provided });
    }

    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : 'request_error',
        // Internal failures must not leak their message to the caller.
        message: status >= 500 ? 'Something went wrong handling that request.' : error.message,
      },
    });
  });

  registerMetaRoutes(app, context);
  registerGenerateRoutes(app, context);

  return app;
}

/**
 * True for a URL that looks like a page the client routes, rather than a
 * request for a file. A path whose last segment carries an extension is asking
 * for an asset, and if that asset is missing the honest answer is 404.
 */
export function isClientNavigation(url: string): boolean {
  if (url.startsWith('/api/')) return false;

  const path = url.split('?')[0] ?? '';
  const lastSegment = path.split('/').pop() ?? '';
  return !lastSegment.includes('.');
}
