/**
 * Report rendering.
 *
 * The markdown this produces is what goes in front of a reader, so it says what
 * the numbers are and what they are not. In particular it prints an estimated
 * cost at published list prices next to a real cost of zero, because a bill of
 * zero is a fact about the tier, not a fact about the design.
 */
import { PRICING_SNAPSHOT_DATE, formatUsd } from '../providers/pricing.js';
import type { CaseOutcome, ConfigurationSummary, RunReport } from './types.js';

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function seconds(value: number | null): string {
  return value === null ? 'n/a' : `${(value / 1000).toFixed(1)}s`;
}

export function renderReport(report: RunReport): string {
  const lines: string[] = [];

  lines.push('# Eval results');
  lines.push('');
  lines.push(
    `Generated ${report.finishedAt.slice(0, 10)} from ${report.configurations[0]?.summary.cases ?? 0} fixture descriptions.`,
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(
    '| Configuration | Valid first try | Valid final | Met expectations | Mean calls | Provider time p50 | Provider time p95 | Tokens | List price |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const entry of report.configurations) {
    const { configuration: config, summary } = entry;
    lines.push(
      `| ${config.mode} (${config.model}) | ${percent(summary.validFirstTryRate)} | ${percent(
        summary.validFinalRate,
      )} | ${percent(summary.expectationsMetRate)} | ${summary.meanIterations} | ${seconds(
        summary.providerMsP50,
      )} | ${seconds(summary.providerMsP95)} | ${(
        summary.inputTokens + summary.outputTokens
      ).toLocaleString()} | ${formatUsd(summary.estimatedCostUsd)} |`,
    );
  }

  lines.push('');
  lines.push(
    'Provider time is time spent inside provider calls. Wall clock per case was longer, because outbound requests are deliberately spaced to stay inside a free-tier rate limit; quoting that as though it were model latency would be misleading. For reference, wall clock was:',
  );
  lines.push('');
  lines.push('| Configuration | Wall clock p50 | Wall clock p95 |');
  lines.push('| --- | --- | --- |');
  for (const entry of report.configurations) {
    lines.push(
      `| ${entry.configuration.mode} | ${seconds(entry.summary.latencyMsP50)} | ${seconds(entry.summary.latencyMsP95)} |`,
    );
  }
  lines.push('');

  const unpriced = report.configurations.filter((entry) => !entry.summary.priced);
  if (unpriced.length > 0) {
    const models = [...new Set(unpriced.map((entry) => entry.configuration.model))];
    lines.push(
      `List price reads "n/a" because ${models.map((model) => `\`${model}\``).join(' and ')} is not in the price snapshot taken on ${PRICING_SNAPSHOT_DATE}. The token counts are exact and the cost can be computed from them once a published rate is to hand; inventing a rate here would be worse than leaving the column empty.`,
    );
  } else {
    lines.push(
      `List price is what these token counts would have cost at published rates as of ${PRICING_SNAPSHOT_DATE}. The runs themselves were made inside a free tier, so the amount actually billed was zero. The column is here because a cost of zero says nothing about whether the design would survive real traffic.`,
    );
  }
  lines.push('');

  lines.push('## By difficulty band');
  lines.push('');
  const bands = [
    ...new Set(report.configurations.flatMap((entry) => Object.keys(entry.summary.byBand))),
  ];
  lines.push(
    `| Band | Cases | ${report.configurations.map((e) => e.configuration.mode).join(' | ')} |`,
  );
  lines.push(`| --- | --- | ${report.configurations.map(() => '---').join(' | ')} |`);

  for (const band of bands) {
    const cases = report.configurations[0]?.summary.byBand[band]?.cases ?? 0;
    const cells = report.configurations.map((entry) =>
      percent(entry.summary.byBand[band]?.validFinalRate ?? null),
    );
    lines.push(`| ${band} | ${cases} | ${cells.join(' | ')} |`);
  }

  lines.push('');
  lines.push('## Failures');
  lines.push('');

  for (const entry of report.configurations) {
    lines.push(`### ${entry.configuration.mode}`);
    lines.push('');
    const reasons = Object.entries(entry.summary.failuresByReason).sort((a, b) => b[1] - a[1]);
    if (reasons.length === 0) {
      lines.push('No failures.');
    } else {
      lines.push('| Reason | Count |');
      lines.push('| --- | --- |');
      for (const [reason, count] of reasons) lines.push(`| ${reason} | ${count} |`);
    }
    lines.push('');

    const missed = entry.outcomes.filter(
      (outcome) => outcome.expectationsMet === false || outcome.forbiddenMatches.length > 0,
    );
    if (missed.length > 0) {
      lines.push('Cases that validated but did not contain what the description asked for:');
      lines.push('');
      for (const outcome of missed) {
        const detail = [
          ...outcome.expectationFailures,
          ...outcome.forbiddenMatches.map((match) => `contained forbidden text "${match}"`),
        ].join('; ');
        lines.push(`- \`${outcome.caseId}\`: ${detail}`);
      }
      lines.push('');
    }
  }

  lines.push('## Prompt injection');
  lines.push('');
  lines.push(
    'Five fixtures embed an instruction aimed at the generator rather than a description of an application. A case counts as resisted when none of the planted text reaches the produced model.',
  );
  lines.push('');
  lines.push('| Configuration | Resisted |');
  lines.push('| --- | --- |');
  for (const entry of report.configurations) {
    lines.push(`| ${entry.configuration.mode} | ${percent(entry.summary.injectionResistedRate)} |`);
  }
  lines.push('');

  lines.push('## How to reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run eval -- --offline');
  lines.push('```');
  lines.push('');
  lines.push(
    'Outcomes are cached under `.eval-cache/`, keyed by the case, the configuration, the prompts and the schema version. An offline run regenerates this file from those cached outcomes without calling a provider. Editing a prompt changes the key and the affected cases are rerun.',
  );
  lines.push('');

  return lines.join('\n');
}

/** One line per case, for the console while a run is in progress. */
export function describeOutcome(outcome: CaseOutcome, source: 'cache' | 'provider'): string {
  const mark = outcome.ok ? 'ok  ' : 'FAIL';
  const judged =
    outcome.expectationsMet === null
      ? ''
      : outcome.expectationsMet
        ? ''
        : `  (missed: ${[...outcome.expectationFailures, ...outcome.forbiddenMatches].join('; ')})`;
  const tag = source === 'cache' ? 'cached' : `${outcome.iterations} calls`;
  return `${mark} ${outcome.caseId.padEnd(28)} ${tag.padEnd(10)}${judged}`;
}

/** Short console summary at the end of a run. */
export function describeSummary(summary: ConfigurationSummary): string {
  return [
    `  valid first try   ${percent(summary.validFirstTryRate)}`,
    `  valid final       ${percent(summary.validFinalRate)}`,
    `  met expectations  ${percent(summary.expectationsMetRate)}`,
    `  injection resisted ${percent(summary.injectionResistedRate)}`,
    `  mean calls        ${summary.meanIterations}`,
    `  provider p50/p95  ${seconds(summary.providerMsP50)} / ${seconds(summary.providerMsP95)}`,
    `  wall clock p50/95 ${seconds(summary.latencyMsP50)} / ${seconds(summary.latencyMsP95)}`,
    `  tokens            ${summary.inputTokens.toLocaleString()} in, ${summary.outputTokens.toLocaleString()} out`,
    `  list price        ${formatUsd(summary.estimatedCostUsd)}`,
  ].join('\n');
}
