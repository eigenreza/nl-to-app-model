/**
 * The generation endpoints.
 *
 * Two routes serve the same work: one returns the finished result, the other
 * streams the trace as it happens. The browser uses the streaming one, because
 * a tool loop takes long enough that showing nothing for the duration is the
 * wrong experience. The eval harness calls the library directly and needs
 * neither.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GenerateResponse, GenerationEvent, GenerationStep } from '@nlam/shared';
import { estimateCostUsd } from '../providers/pricing.js';
import { hashPrompt } from '../logging.js';
import {
  LiveDisabledError,
  LiveUnavailableError,
  ReplayMissError,
  findReplay,
  runLive,
  type RunOutcome,
} from '../generation/run.js';
import { claimLiveGeneration } from '../budget/live-decision.js';
import type { ServerContext } from '../context.js';

export function registerGenerateRoutes(app: FastifyInstance, context: ServerContext): void {
  const BodySchema = z.object({
    description: z
      .string()
      .trim()
      .min(3, 'Describe the application in a few words at least.')
      .max(
        context.config.MAX_PROMPT_CHARS,
        `Descriptions are limited to ${context.config.MAX_PROMPT_CHARS} characters.`,
      ),
    mode: z.enum(['agent', 'baseline']).default('agent'),
  });

  app.post('/api/generate', async (request, reply) => {
    const body = parseBody(BodySchema, request, reply);
    if (!body) return reply;
    if (!authorise(context, request, reply)) return reply;

    const requestId = randomUUID();

    try {
      const outcome = await execute(context, { ...body, requestId, address: request.ip });
      return await reply.send(toResponse(outcome, requestId));
    } catch (error) {
      const described = describeError(error);
      request.log.warn({ requestId, ...described }, 'generation rejected');
      return await reply.status(statusFor(described.code)).send({ error: described });
    }
  });

  app.post('/api/generate/stream', async (request, reply) => {
    const body = parseBody(BodySchema, request, reply);
    if (!body) return reply;
    if (!authorise(context, request, reply)) return reply;

    const requestId = randomUUID();

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    });

    const write = (event: GenerationEvent) => {
      reply.raw.write(`${JSON.stringify(event)}\n`);
    };

    // Stop the generation if the caller disconnects, so an abandoned tab does
    // not keep spending iterations.
    const abort = clientDisconnectSignal(reply);

    try {
      // A recorded trace is tried first, so which source answers is not known
      // until it has. Reporting the configured mode here would be a guess.
      write({
        type: 'accepted',
        requestId,
        mode: body.mode,
        source: context.replay.find(body.description, body.mode) ? 'replay' : 'live',
      });

      const outcome = await execute(context, {
        ...body,
        requestId,
        address: request.ip,
        signal: abort.signal,
        onStep: (step: GenerationStep) => write({ type: 'step', step }),
      });

      abort.settle();
      write({ type: 'result', result: toResponse(outcome, requestId) });
    } catch (error) {
      abort.settle();
      const described = describeError(error);
      request.log.warn({ requestId, ...described }, 'generation stream failed');
      write({ type: 'error', ...described });
    } finally {
      reply.raw.end();
    }

    return reply;
  });
}

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A signal that fires when the browser goes away, and only then.
 *
 * The obvious spelling of this, listening for 'close' on the request, is wrong.
 * Node emits that when the request stream *ends*, which for a small JSON body
 * Fastify has already read and parsed before the handler runs. Every live
 * generation was therefore aborted a couple of milliseconds after it started,
 * before the first provider call could return. The response is the thing that
 * stays open for the length of the stream, so it is the thing to watch.
 *
 * The response also emits 'close' when it ends normally, so the caller marks
 * the work settled first and a late event is ignored.
 */
function clientDisconnectSignal(reply: FastifyReply): AbortController & { settle(): void } {
  const controller = new AbortController() as AbortController & { settle(): void };
  let settled = false;

  controller.settle = () => {
    settled = true;
  };

  reply.raw.on('close', () => {
    if (!settled) controller.abort();
  });

  return controller;
}

interface ExecuteOptions {
  description: string;
  mode: 'agent' | 'baseline';
  requestId: string;
  /** Used only for the per-address live allowance. Never logged or stored. */
  address: string;
  signal?: AbortSignal;
  onStep?: (step: GenerationStep) => void;
}

/**
 * Answers one request.
 *
 * A recorded trace is tried first and always, so the sample prompts work
 * whatever else is true: whether live generation was ever configured, whether
 * the day's budget is gone, whether somebody else is mid-generation. Only a
 * description nobody recorded reaches the guards and the provider.
 */
async function execute(context: ServerContext, options: ExecuteOptions): Promise<RunOutcome> {
  const { config, logger, metrics, replay } = context;
  const startedAt = Date.now();

  const runOptions = {
    description: options.description,
    mode: options.mode,
    maxIterations: config.AGENT_MAX_ITERATIONS,
    timeBudgetMs: config.AGENT_TIME_BUDGET_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onStep ? { onStep: options.onStep } : {}),
  };

  const recorded = findReplay(replay, runOptions);
  const outcome = recorded ?? (await executeLive(context, options, runOptions));

  metrics.record(outcome.result, outcome.source);

  logger.info(
    {
      requestId: options.requestId,
      promptHash: hashPrompt(options.description),
      mode: outcome.result.mode,
      source: outcome.source,
      provider: outcome.result.provider,
      model: outcome.result.model,
      iterations: outcome.result.iterations,
      latencyMs: outcome.result.latencyMs,
      wallMs: Date.now() - startedAt,
      inputTokens: outcome.result.usage.inputTokens,
      outputTokens: outcome.result.usage.outputTokens,
      outcome: outcome.result.ok ? 'accepted' : (outcome.result.failure?.reason ?? 'failed'),
    },
    'generation finished',
  );

  return outcome;
}

/**
 * Runs a description nobody recorded, if every guard allows it.
 *
 * The slot is released in a finally, because a generation that throws still
 * has to give the next visitor their turn. The per-address allowance is not
 * refunded on failure: it is spent on asking, which is what stops a failing
 * prompt from being retried indefinitely.
 */
async function executeLive(
  context: ServerContext,
  options: ExecuteOptions,
  runOptions: Parameters<typeof runLive>[1],
): Promise<RunOutcome> {
  const gate = {
    configured: context.config.liveGenerationEnabled && context.provider !== undefined,
    budget: context.dailyBudget,
    access: context.liveAccess,
  };

  const decision = claimLiveGeneration(gate, options.address);
  if (!decision.allowed) {
    throw new LiveUnavailableError(decision.reason, context.replay.catalogue());
  }

  try {
    const outcome = await runLive(
      context.provider as NonNullable<ServerContext['provider']>,
      runOptions,
    );
    await context.dailyBudget?.countGeneration();
    return outcome;
  } finally {
    decision.release();
  }
}

function toResponse(outcome: RunOutcome, requestId: string): GenerateResponse {
  return {
    ...outcome.result,
    requestId,
    source: outcome.source,
    // A replayed answer costs nothing, which is the point of replay mode.
    estimatedCostUsd:
      outcome.source === 'live' ? estimateCostUsd(outcome.result.model, outcome.result.usage) : 0,
  };
}

function parseBody<T extends z.ZodType>(
  schema: T,
  request: FastifyRequest,
  reply: FastifyReply,
): z.infer<T> | null {
  const parsed = schema.safeParse(request.body);
  if (parsed.success) return parsed.data;

  void reply.status(400).send({
    error: {
      code: 'invalid_request',
      message: parsed.error.issues[0]?.message ?? 'The request body is not valid.',
      detail: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
  return null;
}

/**
 * Live generation on a public deployment is gated by a shared token. This is
 * deliberately not an account system: the only thing that needs protecting is
 * the ability to spend provider quota.
 */
function authorise(context: ServerContext, request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = context.config.DEMO_ACCESS_TOKEN;
  if (!context.config.liveGenerationEnabled || expected === '') return true;

  const presented = request.headers['x-demo-token'];
  if (typeof presented === 'string' && constantTimeEqual(presented, expected)) return true;

  void reply.status(401).send({
    error: {
      code: 'unauthorised',
      message: 'Live generation on this deployment requires an access token.',
    },
  });
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function describeError(error: unknown): { code: string; message: string; detail?: unknown } {
  if (error instanceof ReplayMissError) {
    return {
      code: 'replay_miss',
      message: error.message,
      detail: { availableDescriptions: error.available },
    };
  }
  if (error instanceof LiveUnavailableError) {
    return {
      // 'not_configured' is the case that existed before live generation did, so
      // it keeps the code it had rather than renaming a published contract.
      code: error.reason === 'not_configured' ? 'replay_miss' : `live_${error.reason}`,
      message: error.message,
      detail: { availableDescriptions: error.available.map((entry) => entry.description) },
    };
  }
  if (error instanceof LiveDisabledError) {
    return { code: 'live_disabled', message: error.message };
  }
  return {
    code: 'generation_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function statusFor(code: string): number {
  if (code === 'replay_miss' || code === 'live_not_configured') return 409;
  if (code === 'live_rate_limited') return 429;
  if (code === 'live_busy') return 503;
  if (code === 'live_budget_exhausted' || code === 'live_disabled') return 503;
  return 502;
}
