/**
 * The single entry point for deciding whether a document is a valid
 * application model.
 *
 * Validation runs in two stages and never skips ahead: if the document is not
 * structurally sound there is no point asking whether its cross references
 * resolve, and attempting it would produce a second wave of confusing errors on
 * top of the real one.
 */
import { ApplicationModelSchema, SCHEMA_VERSION, type ApplicationModel } from './model.js';
import { fromZodIssue, issue, type ValidationIssue } from './issues.js';
import { checkSemantics } from './semantics.js';

export interface ValidationResult {
  /** True when there are no error-severity issues. Warnings do not block. */
  ok: boolean;
  /** The parsed model with defaults applied, or null when validation failed. */
  model: ApplicationModel | null;
  /** Errors and warnings together, in reporting order. */
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function result(model: ApplicationModel | null, issues: ValidationIssue[]): ValidationResult {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return {
    ok: errors.length === 0,
    model: errors.length === 0 ? model : null,
    issues,
    errors,
    warnings,
  };
}

/**
 * Validates an already-parsed value. Structural failures return immediately;
 * only a structurally valid document reaches the cross-reference checks.
 */
export function validateApplicationModel(input: unknown): ValidationResult {
  const parsed = ApplicationModelSchema.safeParse(input);
  if (!parsed.success) {
    return result(null, parsed.error.issues.map(fromZodIssue));
  }
  return result(parsed.data, checkSemantics(parsed.data));
}

/**
 * Validates JSON text, as typed into the editor or returned by a provider.
 * A syntax error is reported as an ordinary issue rather than thrown, so the
 * editor and the agent loop can handle it the same way as everything else.
 */
export function validateApplicationModelJson(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return result(null, [
      issue('(root)', 'invalid_json', `The document is not valid JSON: ${detail}`),
    ]);
  }
  return validateApplicationModel(parsed);
}

/** Throws on invalid input. Used by tests and by trusted internal callers. */
export function assertApplicationModel(input: unknown): ApplicationModel {
  const validation = validateApplicationModel(input);
  if (!validation.ok || !validation.model) {
    const lines = validation.errors.map((i) => `  ${i.path}: ${i.message}`).join('\n');
    throw new Error(`Invalid application model:\n${lines}`);
  }
  return validation.model;
}

/**
 * Stamps the current schema version onto a candidate document. The generator
 * never has to produce this field, which removes a whole class of avoidable
 * validation failures.
 */
export function withSchemaVersion(candidate: unknown): unknown {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return candidate;
  }
  return { ...(candidate as Record<string, unknown>), schemaVersion: SCHEMA_VERSION };
}
