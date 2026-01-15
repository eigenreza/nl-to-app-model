/**
 * Prints what a paid eval run would cost, before it costs it.
 *
 * Token counts come from the provider's free counting endpoint, so the prefix
 * sizes are exact. What is estimated is the shape of a run: how many turns a
 * case takes and how much conversation each turn adds. Those come from the
 * measured Gemini runs and are stated in the output, so the estimate can be
 * checked against the actual spend afterwards rather than quietly forgotten.
 */
import '../env.js';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { EVAL_CASES } from './fixtures.js';
import { MEASURED_SHAPE, estimateSpend, measurePrefixes, type SpendEstimate } from './estimate.js';

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function line(label: string, estimate: SpendEstimate): string {
  return `  ${label.padEnd(34)} ${usd(estimate.totalUsd).padStart(9)}   agent ${usd(
    estimate.agent.costUsd,
  ).padStart(8)}   baseline ${usd(estimate.baseline.costUsd).padStart(8)}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const cases = Number(process.env.ESTIMATE_CASES ?? EVAL_CASES.length);

  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set, and token counting needs it.');
  }

  const model = config.LLM_PROVIDER === 'anthropic' ? config.model : 'claude-haiku-4-5-20251001';
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 1 });

  console.log(`Measuring prompt sizes against ${model} (counting tokens is free).`);
  const prefixes = await measurePrefixes(client, model);

  console.log('');
  console.log('Measured prefix sizes, in tokens:');
  console.log(`  agent system prompt            ${prefixes.agentSystemTokens}`);
  console.log(`  agent tool definitions         ${prefixes.agentToolTokens}`);
  console.log(
    `  agent static prefix per call   ${prefixes.agentSystemTokens + prefixes.agentToolTokens}`,
  );
  console.log(`  baseline system prompt         ${prefixes.baselineSystemTokens}`);

  console.log('');
  console.log('Assumed run shape, measured from the Gemini runs:');
  console.log(`  agent turns per case           ${MEASURED_SHAPE.agentTurns}`);
  console.log(`  conversation added per turn    ${MEASURED_SHAPE.agentTurnGrowthTokens} tokens`);
  console.log(`  agent output per turn          ${MEASURED_SHAPE.agentOutputTokensPerTurn} tokens`);
  console.log(`  baseline calls per case        ${MEASURED_SHAPE.baselineCalls}`);
  console.log(`  baseline output per call       ${MEASURED_SHAPE.baselineOutputTokens} tokens`);

  const variants: Array<[string, { promptCaching: boolean; batchBaseline: boolean }]> = [
    ['no savings', { promptCaching: false, batchBaseline: false }],
    ['prompt caching only', { promptCaching: true, batchBaseline: false }],
    ['batch API only', { promptCaching: false, batchBaseline: true }],
    ['prompt caching and batch API', { promptCaching: true, batchBaseline: true }],
  ];

  console.log('');
  console.log(`Estimated spend for ${cases} fixtures in both modes:`);
  console.log('');

  const results = variants.map(
    ([label, flags]) => [label, estimateSpend({ model, cases, prefixes, ...flags })] as const,
  );

  for (const [label, estimate] of results) console.log(line(label, estimate));

  const worst = results[0]?.[1];
  const best = results.at(-1)?.[1];
  if (worst && best) {
    const saved = worst.totalUsd - best.totalUsd;
    console.log('');
    console.log(
      `Savings from caching and batching: ${usd(saved)}, which is ${Math.round(
        (saved / worst.totalUsd) * 100,
      )}% of the unoptimised figure.`,
    );
    console.log(
      `Calls: ${best.agent.calls} agent, ${best.baseline.calls} baseline, ${best.agent.calls + best.baseline.calls} in total.`,
    );
  }

  if (config.LLM_SPEND_CAP_USD > 0) {
    console.log('');
    console.log(`Hard spend cap in force: $${config.LLM_SPEND_CAP_USD.toFixed(2)}.`);
  }

  console.log('');
  console.log('Nothing was generated. Counting tokens does not bill.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
