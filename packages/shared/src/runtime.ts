/**
 * The interpreter.
 *
 * A validated model describes what the application contains; this module says
 * what it does. It holds rows, evaluates the whitelisted comparison operators,
 * and computes the aggregates behind metric cards. It is deliberately pure and
 * free of React and Redux imports, so the same code runs in the browser, in the
 * eval harness and in unit tests.
 */
import {
  entityPluralName,
  type ApplicationModel,
  type CellValue,
  type Condition,
  type Entity,
  type Field,
  type FilterExpression,
  type MetricComponent,
  type TableComponent,
} from './model.js';

export interface RuntimeRow {
  /** Assigned by the runtime. Never part of the model or of user data. */
  id: string;
  values: Record<string, CellValue>;
}

/** Rows held per entity id. */
export type EntityData = Record<string, RuntimeRow[]>;

let rowCounter = 0;

export function createRowId(prefix = 'row'): string {
  rowCounter += 1;
  return `${prefix}_${rowCounter}`;
}

/** Resets the row id counter. Used by tests that assert on generated ids. */
export function resetRowIds(): void {
  rowCounter = 0;
}

/** The value a field holds when nothing has been entered for it. */
export function emptyValueForField(field: Field): CellValue {
  return field.type === 'boolean' ? false : null;
}

/** Fills in every declared field so downstream code never sees a missing key. */
export function normaliseRow(entity: Entity, values: Record<string, CellValue>): RuntimeRow {
  const normalised: Record<string, CellValue> = {};
  for (const field of entity.fields) {
    const raw = values[field.id];
    normalised[field.id] = raw === undefined ? emptyValueForField(field) : raw;
  }
  return { id: createRowId(entity.id), values: normalised };
}

/** Builds the starting dataset from the seed rows declared in the model. */
export function createInitialData(model: ApplicationModel): EntityData {
  const data: EntityData = {};
  for (const entity of model.entities) {
    data[entity.id] = (entity.seed ?? []).map((row) => normaliseRow(entity, row));
  }
  return data;
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

function isEmptyValue(value: CellValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Compares two values that are already known to be the same kind. Dates are ISO
 * strings, which sort correctly as text, so numbers and dates share one path.
 */
function compareOrdered(left: CellValue, right: CellValue): number | null {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

export function evaluateCondition(condition: Condition, row: RuntimeRow): boolean {
  const actual = row.values[condition.fieldId] ?? null;
  const expected = condition.value;

  switch (condition.op) {
    case 'isEmpty':
      return isEmptyValue(actual);
    case 'isNotEmpty':
      return !isEmptyValue(actual);
    case 'isTrue':
      return actual === true;
    case 'isFalse':
      return actual === false;
    case 'equals':
      return actual === (expected ?? null);
    case 'notEquals':
      return actual !== (expected ?? null);
    case 'contains':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    case 'greaterThan':
    case 'greaterThanOrEqual':
    case 'lessThan':
    case 'lessThanOrEqual': {
      if (isEmptyValue(actual) || expected === undefined || expected === null) return false;
      const order = compareOrdered(actual, expected);
      if (order === null) return false;
      if (condition.op === 'greaterThan') return order > 0;
      if (condition.op === 'greaterThanOrEqual') return order >= 0;
      if (condition.op === 'lessThan') return order < 0;
      return order <= 0;
    }
    default:
      return false;
  }
}

export function evaluateFilterExpression(expression: FilterExpression, row: RuntimeRow): boolean {
  if (expression.combinator === 'or') {
    return expression.conditions.some((condition) => evaluateCondition(condition, row));
  }
  return expression.conditions.every((condition) => evaluateCondition(condition, row));
}

export function applyFilterExpression(
  expression: FilterExpression | undefined,
  rows: readonly RuntimeRow[],
): RuntimeRow[] {
  if (!expression) return [...rows];
  return rows.filter((row) => evaluateFilterExpression(expression, row));
}

/* -------------------------------------------------------------------------- */
/* Interactive table filters                                                  */
/* -------------------------------------------------------------------------- */

/** Values currently entered into a table's filter controls, keyed by field id. */
export type TableFilterState = Record<string, string>;

/**
 * Applies the model's fixed filter first, then whatever the user typed or
 * selected. An empty control means "no restriction", which is why the state is
 * held as strings: an empty string is the natural neutral value for both a text
 * box and a select.
 */
export function selectTableRows(
  component: TableComponent,
  entity: Entity,
  rows: readonly RuntimeRow[],
  filterState: TableFilterState = {},
): RuntimeRow[] {
  let selected = applyFilterExpression(component.where, rows);

  for (const filter of component.filters ?? []) {
    const raw = filterState[filter.fieldId];
    if (raw === undefined || raw === '') continue;

    const field = entity.fields.find((f) => f.id === filter.fieldId);
    if (!field) continue;

    if (filter.control === 'text') {
      const needle = raw.toLowerCase();
      selected = selected.filter((row) => {
        const value = row.values[filter.fieldId];
        return typeof value === 'string' && value.toLowerCase().includes(needle);
      });
      continue;
    }

    if (field.type === 'boolean') {
      const wanted = raw === 'true';
      selected = selected.filter((row) => row.values[filter.fieldId] === wanted);
      continue;
    }

    selected = selected.filter((row) => row.values[filter.fieldId] === raw);
  }

  return selected;
}

/** The options a select filter should offer, including the neutral entry. */
export function filterOptions(field: Field): Array<{ value: string; label: string }> {
  const neutral = { value: '', label: 'Any' };
  if (field.type === 'boolean') {
    return [neutral, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
  }
  return [neutral, ...(field.options ?? []).map((option) => ({ value: option, label: option }))];
}

/* -------------------------------------------------------------------------- */
/* Aggregates                                                                 */
/* -------------------------------------------------------------------------- */

export interface MetricResult {
  /** Null when there is nothing to aggregate, for example an average of no rows. */
  value: number | null;
  formatted: string;
  /** How many rows passed the metric's filter. Shown as supporting detail. */
  matchedRows: number;
}

export function computeMetric(
  component: MetricComponent,
  rows: readonly RuntimeRow[],
): MetricResult {
  const matched = applyFilterExpression(component.where, rows);

  if (component.aggregate === 'count') {
    return {
      value: matched.length,
      formatted: formatNumber(matched.length),
      matchedRows: matched.length,
    };
  }

  const fieldId = component.fieldId;
  const numbers = fieldId
    ? matched
        .map((row) => row.values[fieldId])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : [];

  if (numbers.length === 0) {
    return { value: null, formatted: 'n/a', matchedRows: matched.length };
  }

  let value: number;
  switch (component.aggregate) {
    case 'sum':
      value = numbers.reduce((total, n) => total + n, 0);
      break;
    case 'average':
      value = numbers.reduce((total, n) => total + n, 0) / numbers.length;
      break;
    case 'min':
      value = Math.min(...numbers);
      break;
    case 'max':
      value = Math.max(...numbers);
      break;
    default:
      value = 0;
  }

  return { value, formatted: formatNumber(value), matchedRows: matched.length };
}

/** Two decimal places at most, with trailing zeros removed. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Renders a stored value for display. Empty cells become a visible placeholder. */
export function formatCellValue(value: CellValue | undefined, field: Field): string {
  if (isEmptyValue(value)) return '';
  if (field.type === 'boolean') return value === true ? 'Yes' : 'No';
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}

/** Field ids a table shows, honouring an explicit column list when present. */
export function tableColumns(component: TableComponent, entity: Entity): Field[] {
  if (!component.columns || component.columns.length === 0) return [...entity.fields];
  return component.columns
    .map((fieldId) => entity.fields.find((f) => f.id === fieldId))
    .filter((field): field is Field => field !== undefined);
}

/** Field ids a form collects, honouring an explicit list when present. */
export function formFields(
  component: { fieldIds?: string[] | undefined },
  entity: Entity,
): Field[] {
  if (!component.fieldIds || component.fieldIds.length === 0) return [...entity.fields];
  return component.fieldIds
    .map((fieldId) => entity.fields.find((f) => f.id === fieldId))
    .filter((field): field is Field => field !== undefined);
}

/** Looks an entity up by id. Returns undefined rather than throwing. */
export function findEntity(model: ApplicationModel, entityId: string): Entity | undefined {
  return model.entities.find((entity) => entity.id === entityId);
}

/** Default title for a component that did not declare one. */
export function defaultComponentTitle(
  component: ApplicationModel['components'][number],
  entity: Entity | undefined,
): string {
  if (component.title) return component.title;
  if (!entity) return 'Untitled';
  switch (component.type) {
    case 'table':
      return entityPluralName(entity);
    case 'form':
      return `Add ${entity.name.toLowerCase()}`;
    case 'metric':
      return `${component.aggregate} of ${entityPluralName(entity).toLowerCase()}`;
    default:
      return 'Untitled';
  }
}
