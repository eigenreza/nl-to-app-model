import { isIsoDate, type CellValue, type Field } from '@nlam/shared';

/**
 * Form inputs hand back strings whatever the field type is, so the value a user
 * typed has to be converted before it can join the dataset. Doing that here,
 * outside React, keeps the rules testable and keeps the same guarantees the
 * schema makes about seed data true of rows the user adds.
 */
export interface DraftResult {
  values: Record<string, CellValue>;
  errors: Record<string, string>;
}

export function draftValue(field: Field, draft: Record<string, string>): string {
  const raw = draft[field.id];
  if (raw !== undefined) return raw;
  return field.type === 'boolean' ? 'false' : '';
}

export function coerceDraft(fields: readonly Field[], draft: Record<string, string>): DraftResult {
  const values: Record<string, CellValue> = {};
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const raw = draftValue(field, draft).trim();

    if (field.type === 'boolean') {
      values[field.id] = raw === 'true';
      continue;
    }

    if (raw === '') {
      if (field.required) {
        errors[field.id] = `${field.label} is required.`;
      }
      values[field.id] = null;
      continue;
    }

    switch (field.type) {
      case 'number': {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          errors[field.id] = `${field.label} must be a number.`;
          values[field.id] = null;
        } else {
          values[field.id] = parsed;
        }
        break;
      }
      case 'date': {
        if (!isIsoDate(raw)) {
          errors[field.id] = `${field.label} must be a date in YYYY-MM-DD form.`;
          values[field.id] = null;
        } else {
          values[field.id] = raw;
        }
        break;
      }
      case 'enum': {
        if (!field.options?.includes(raw)) {
          errors[field.id] = `${field.label} must be one of the listed options.`;
          values[field.id] = null;
        } else {
          values[field.id] = raw;
        }
        break;
      }
      default:
        values[field.id] = raw;
    }
  }

  return { values, errors };
}
