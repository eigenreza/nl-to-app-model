/**
 * Validation issues.
 *
 * Every issue this project reports, whether it came from Zod or from a
 * cross-reference check, ends up in this one shape. That matters because the
 * same list is consumed by three very different readers:
 *
 * - the agent loop, which feeds failures back to the model as repair instructions,
 * - the JSON editor in the browser, which shows them next to the text,
 * - the eval harness, which buckets them into a failure taxonomy.
 *
 * So messages are written as instructions to whoever has to fix the document,
 * and the path is always a plain dotted string rather than an array of keys.
 */
import type { z } from 'zod';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  /** Dotted path into the document, for example "components[2].entityId". */
  path: string;
  /** Stable machine code, used for the eval failure taxonomy. */
  code: string;
  /** Actionable sentence describing what to change. */
  message: string;
  severity: IssueSeverity;
}

/** Renders a Zod path (or any key list) as a dotted, bracketed string. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out += out.length === 0 ? String(segment) : `.${String(segment)}`;
    }
  }
  return out;
}

export function issue(
  path: string,
  code: string,
  message: string,
  severity: IssueSeverity = 'error',
): ValidationIssue {
  return { path, code, message, severity };
}

/**
 * Maps a Zod issue onto our shape. Zod's own messages are good and the schema
 * overrides them where a domain-specific sentence reads better, so this mostly
 * normalises the code and rewrites the two cases where the default message is
 * not actionable on its own.
 */
export function fromZodIssue(zodIssue: z.core.$ZodIssue): ValidationIssue {
  const path = formatPath(zodIssue.path);

  if (zodIssue.code === 'unrecognized_keys') {
    const keys = zodIssue.keys.map((k) => `"${k}"`).join(', ');
    const plural = zodIssue.keys.length === 1 ? 'key is' : 'keys are';
    return issue(
      path,
      'unrecognized_key',
      `Unknown ${plural} not part of the schema and must be removed: ${keys}.`,
    );
  }

  if (zodIssue.code === 'invalid_type') {
    return issue(
      path,
      'invalid_type',
      `Expected ${zodIssue.expected} here but received ${describeReceived(zodIssue.input)}.`,
    );
  }

  return issue(path, zodIssue.code ?? 'invalid_value', zodIssue.message);
}

function describeReceived(input: unknown): string {
  if (input === null) return 'null';
  if (input === undefined) return 'nothing';
  if (Array.isArray(input)) return 'an array';
  return typeof input === 'object' ? 'an object' : `a ${typeof input}`;
}

/**
 * Renders issues as a numbered list for a repair prompt. Capped, because a
 * badly broken document can produce dozens of issues and a long list crowds out
 * the part of the context that actually helps the model fix things.
 */
export function formatIssuesForPrompt(issues: readonly ValidationIssue[], limit = 12): string {
  const errors = issues.filter((i) => i.severity === 'error');
  const shown = errors.slice(0, limit);
  const lines = shown.map((i, index) => `${index + 1}. at ${i.path}: ${i.message}`);
  if (errors.length > shown.length) {
    lines.push(`... and ${errors.length - shown.length} more of the same kind.`);
  }
  return lines.join('\n');
}

/** One-line human summary, used in logs and in the failure report. */
export function summariseIssues(issues: readonly ValidationIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  if (errors === 0 && warnings === 0) return 'no issues';
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return parts.join(', ');
}
