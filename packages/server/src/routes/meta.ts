/**
 * Endpoints that describe the deployment rather than doing work: health, the
 * replay catalogue, and a small stats summary.
 *
 * The stats endpoint is deliberately modest. A project this size does not need
 * a metrics stack, but it does need an answer to "is it up, is it working, and
 * how many tokens has it spent today", and that answer should not require
 * reading the logs.
 */
import type { FastifyInstance } from 'fastify';
import { SCHEMA_VERSION, type CatalogueEntry, type HealthResponse } from '@nlam/shared';
import type { ServerContext } from '../context.js';

export function registerMetaRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    // In replay mode no provider is constructed, so naming the configured one
    // would credit the answers to somewhere they did not come from. What the
    // recorded traces were generated with is the honest answer.
    const provenance = context.config.liveGenerationEnabled
      ? undefined
      : context.replay.provenance();

    return {
      status: 'ok',
      demoMode: context.config.DEMO_MODE,
      provider: provenance?.provider ?? context.config.LLM_PROVIDER,
      model: provenance?.model ?? context.config.model,
      schemaVersion: SCHEMA_VERSION,
      replayTraces: context.replay.size,
      liveGenerationEnabled: context.config.liveGenerationEnabled,
    };
  });

  app.get('/api/catalogue', async (): Promise<{ entries: CatalogueEntry[] }> => {
    return { entries: context.replay.catalogue() };
  });

  app.get('/api/stats', async () => context.metrics.snapshot());
}
