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
import {
  SCHEMA_VERSION,
  type CatalogueEntry,
  type HealthResponse,
  type LiveStatus,
} from '@nlam/shared';
import { liveAvailability } from '../budget/live-decision.js';
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
      ...(liveStatus(context) ? { live: liveStatus(context) } : {}),
    };
  });

  app.get('/api/catalogue', async (): Promise<{ entries: CatalogueEntry[] }> => {
    return { entries: context.replay.catalogue() };
  });

  app.get('/api/stats', async () => context.metrics.snapshot());
}

/**
 * What the browser needs to tell a visitor whether it can build something new,
 * and if not, when that might change.
 *
 * Absent entirely on a deployment that was never configured for live
 * generation, so the client can distinguish "off" from "out of budget".
 */
function liveStatus(context: ServerContext): LiveStatus | undefined {
  if (!context.config.liveGenerationEnabled || !context.dailyBudget) return undefined;

  const snapshot = context.dailyBudget.snapshot();
  const availability = liveAvailability({
    configured: true,
    budget: context.dailyBudget,
    access: context.liveAccess,
  });

  return {
    configured: true,
    available: availability.available,
    ...(availability.reason ? { reason: availability.reason } : {}),
    dailyCapUsd: round(snapshot.capUsd),
    spentTodayUsd: round(snapshot.spentUsd),
    remainingUsd: round(snapshot.remainingUsd),
    utcDate: snapshot.utcDate,
    generationsToday: snapshot.generations,
  };
}

/** Four decimals: enough to see a single generation move the number. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
