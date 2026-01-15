/**
 * Spend estimate.
 *
 * Run before a paid batch, so the number that matters is known in advance
 * rather than discovered afterwards. Token counts come from the provider's own
 * counting endpoint, which is free, rather than from a characters-over-four
 * guess, because the whole point is to be able to trust the figure.
 *
 * The estimate models what actually drives cost on a tool loop: a large static
 * prefix (system prompt plus tool definitions) resent on every turn, and a
 * conversation that grows as tool results accumulate.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { pricingFor } from '../providers/pricing.js';
import { toAnthropicMessages } from '../providers/anthropic.js';
import { agentSystemPrompt, agentUserPrompt, baselineSystemPrompt, baselineUserPrompt } from '../generation/prompts.js';
import { toolDefinitions } from '../generation/tools.js';

export interface ShapeAssumptions {
  /** Turns a typical agent case takes. */
  agentTurns: number;
  /** Tokens of conversation added by each completed turn (tool results plus calls). */
  agentTurnGrowthTokens: number;
  /** Output tokens a typical agent turn emits. */
  agentOutputTokensPerTurn: number;
  /** Calls a typical baseline case takes, counting the occasional repair. */
  baselineCalls: number;
  /** Output tokens a baseline completion emits, which is a whole model document. */
  baselineOutputTokens: number;
}

/**
 * Taken from the smoke tests rather than invented. The agent figures come from
 * a complete Anthropic run of the book_tracker fixture: four turns, 15,126
 * input tokens and 1,163 output tokens, of which 12,040 input was the static
 * prefix resent each turn. Stated here so the estimate can be checked against
 * the actual spend afterwards rather than quietly forgotten.
 */
export const MEASURED_SHAPE: ShapeAssumptions = {
  agentTurns: 4,
  agentTurnGrowthTokens: 480,
  agentOutputTokensPerTurn: 290,
  baselineCalls: 1.3,
  baselineOutputTokens: 1500,
};

export interface PrefixSizes {
  agentSystemTokens: number;
  agentToolTokens: number;
  agentUserTokens: number;
  baselineSystemTokens: number;
  baselineUserTokens: number;
}

/** Counts the real prompts with the provider's free counting endpoint. */
export async function measurePrefixes(client: Anthropic, model: string): Promise<PrefixSizes> {
  const sample = 'a book tracker with a table of books, a filter by genre, and a count of unread books';

  // The API rejects an empty user turn, so every measurement carries the same
  // one-character placeholder and the sizes are recovered by difference.
  const PLACEHOLDER = '.';

  const count = async (options: {
    system?: string;
    text?: string;
    tools?: Anthropic.Tool[];
  }): Promise<number> => {
    const response = await client.messages.countTokens({
      model,
      ...(options.system ? { system: options.system } : {}),
      messages: toAnthropicMessages([{ role: 'user', content: options.text ?? PLACEHOLDER }]),
      ...(options.tools ? { tools: options.tools } : {}),
    });
    return response.input_tokens;
  };

  const tools = toolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));

  // Counting is only available for a whole request, so each part is recovered
  // by difference from a request that omits it.
  const bare = await count({});
  const agentUser = await count({ text: agentUserPrompt(sample) });
  const agentSystem = await count({ system: agentSystemPrompt() });
  const agentWithTools = await count({ system: agentSystemPrompt(), tools });
  const baselineUser = await count({ text: baselineUserPrompt(sample) });
  const baselineSystem = await count({ system: baselineSystemPrompt() });

  return {
    agentSystemTokens: agentSystem - bare,
    agentToolTokens: agentWithTools - agentSystem,
    agentUserTokens: agentUser - bare,
    baselineSystemTokens: baselineSystem - bare,
    baselineUserTokens: baselineUser - bare,
  };
}

export interface ModeEstimate {
  calls: number;
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SpendEstimate {
  model: string;
  cases: number;
  agent: ModeEstimate;
  baseline: ModeEstimate;
  totalUsd: number;
}

export interface EstimateOptions {
  model: string;
  cases: number;
  prefixes: PrefixSizes;
  shape?: ShapeAssumptions;
  /** Static prefix served from cache after the first write. */
  promptCaching: boolean;
  /** Baseline calls submitted through the batch API at half price. */
  batchBaseline: boolean;
  /**
   * How many times the cache is written rather than read. The prefix is shared
   * by every case, and the throttle keeps calls closer together than the cache
   * lifetime, so in practice it is written once per lifetime rather than once
   * per case.
   */
  cacheWrites?: number;
}

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
const BATCH_MULTIPLIER = 0.5;

export function estimateSpend(options: EstimateOptions): SpendEstimate {
  const shape = options.shape ?? MEASURED_SHAPE;
  const pricing = pricingFor(options.model);
  if (!pricing) {
    throw new Error(
      `No published price on record for "${options.model}", so no estimate can be made. Add it to the pricing table first.`,
    );
  }

  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  const cacheWrites = options.cacheWrites ?? 30;

  /* ---- agent ---------------------------------------------------------- */

  const agentStatic = options.prefixes.agentSystemTokens + options.prefixes.agentToolTokens;
  const agentCalls = Math.round(options.cases * shape.agentTurns);

  // The conversation grows by one turn's worth of calls and results each time,
  // so its total across a case is the triangular number of the growth.
  const growthPerCase =
    options.prefixes.agentUserTokens * shape.agentTurns +
    shape.agentTurnGrowthTokens * ((shape.agentTurns * (shape.agentTurns - 1)) / 2);

  const agentDynamicTokens = Math.round(options.cases * growthPerCase);
  const agentStaticTotal = agentCalls * agentStatic;
  const agentOutput = agentCalls * shape.agentOutputTokensPerTurn;

  const agentCacheWrites = options.promptCaching ? Math.min(cacheWrites, agentCalls) * agentStatic : 0;
  const agentCacheReads = options.promptCaching ? agentStaticTotal - agentCacheWrites : 0;
  const agentFullPriceInput = options.promptCaching ? agentDynamicTokens : agentStaticTotal + agentDynamicTokens;

  const agentCost =
    perMillion(agentFullPriceInput, pricing.inputPerMillion) +
    perMillion(agentCacheWrites * CACHE_WRITE_MULTIPLIER, pricing.inputPerMillion) +
    perMillion(agentCacheReads * CACHE_READ_MULTIPLIER, pricing.inputPerMillion) +
    perMillion(agentOutput, pricing.outputPerMillion);

  /* ---- baseline ------------------------------------------------------- */

  const baselineCalls = Math.round(options.cases * shape.baselineCalls);
  const baselineStatic = options.prefixes.baselineSystemTokens;
  const baselineStaticTotal = baselineCalls * baselineStatic;
  const baselineDynamic = baselineCalls * options.prefixes.baselineUserTokens;
  const baselineOutput = baselineCalls * shape.baselineOutputTokens;

  const baselineCacheWrites = options.promptCaching
    ? Math.min(cacheWrites, baselineCalls) * baselineStatic
    : 0;
  const baselineCacheReads = options.promptCaching ? baselineStaticTotal - baselineCacheWrites : 0;
  const baselineFullPriceInput = options.promptCaching
    ? baselineDynamic
    : baselineStaticTotal + baselineDynamic;

  const batchFactor = options.batchBaseline ? BATCH_MULTIPLIER : 1;

  const baselineCost =
    batchFactor *
    (perMillion(baselineFullPriceInput, pricing.inputPerMillion) +
      perMillion(baselineCacheWrites * CACHE_WRITE_MULTIPLIER, pricing.inputPerMillion) +
      perMillion(baselineCacheReads * CACHE_READ_MULTIPLIER, pricing.inputPerMillion) +
      perMillion(baselineOutput, pricing.outputPerMillion));

  return {
    model: options.model,
    cases: options.cases,
    agent: {
      calls: agentCalls,
      inputTokens: agentFullPriceInput,
      cachedReadTokens: agentCacheReads,
      cacheWriteTokens: agentCacheWrites,
      outputTokens: agentOutput,
      costUsd: round(agentCost),
    },
    baseline: {
      calls: baselineCalls,
      inputTokens: baselineFullPriceInput,
      cachedReadTokens: baselineCacheReads,
      cacheWriteTokens: baselineCacheWrites,
      outputTokens: baselineOutput,
      costUsd: round(baselineCost),
    },
    totalUsd: round(agentCost + baselineCost),
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
