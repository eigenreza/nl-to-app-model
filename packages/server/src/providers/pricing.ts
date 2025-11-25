/**
 * Cost estimation.
 *
 * The deployed configuration runs inside a free tier, so the real bill is zero.
 * That is exactly why this exists: a number that is always zero tells you
 * nothing about whether the design would survive contact with production
 * traffic. The eval report therefore carries what the same token counts would
 * cost at published list prices.
 *
 * Prices are USD per million tokens, taken from each vendor's public pricing
 * page. They move, so they live in one table with a version note rather than
 * being scattered through the reporting code.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Recorded so a stale table is visible in the report rather than silent. */
export const PRICING_SNAPSHOT_DATE = '2025-12-01';

const PRICING: Record<string, ModelPricing> = {
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
};

/**
 * Looks pricing up by the longest key that prefixes the model id, so dated
 * variants such as claude-haiku-4-5-20251001 resolve without a table entry each.
 */
export function pricingFor(model: string): ModelPricing | undefined {
  const direct = PRICING[model];
  if (direct) return direct;

  let best: { key: string; pricing: ModelPricing } | undefined;
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, pricing };
    }
  }
  return best?.pricing;
}

/** Returns null when the model is not in the table, so callers can say so. */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const pricing = pricingFor(model);
  if (!pricing) return null;

  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/** Formats a cost with enough precision to be useful at these volumes. */
export function formatUsd(value: number | null): string {
  if (value === null) return 'n/a';
  if (value === 0) return '$0.0000';
  return `$${value.toFixed(4)}`;
}
