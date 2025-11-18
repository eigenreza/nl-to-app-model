/**
 * Cross-reference checks.
 *
 * Zod tells us the document has the right shape. It cannot tell us that a table
 * points at an entity that exists, that a metric sums a field that holds
 * numbers, or that a seed row uses one of the enum options it was given. Those
 * are the mistakes a language model actually makes, so they get the most
 * careful error messages in the project: each one names the offending value and
 * says what the valid alternatives are, because that text is what the agent
 * loop reads when it repairs a model.
 */
import {
  entityPluralName,
  isBinaryOperator,
  type ApplicationModel,
  type CellValue,
  type ComparisonOperator,
  type Condition,
  type Entity,
  type Field,
  type FieldType,
  type FilterExpression,
} from './model.js';
import { issue, type ValidationIssue } from './issues.js';

/** Operators each field type accepts. Anything outside this table is rejected. */
const OPERATORS_BY_FIELD_TYPE: Record<FieldType, readonly ComparisonOperator[]> = {
  string: ['equals', 'notEquals', 'contains', 'isEmpty', 'isNotEmpty'],
  number: [
    'equals',
    'notEquals',
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'isEmpty',
    'isNotEmpty',
  ],
  boolean: ['equals', 'notEquals', 'isTrue', 'isFalse'],
  date: [
    'equals',
    'notEquals',
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'isEmpty',
    'isNotEmpty',
  ],
  enum: ['equals', 'notEquals', 'isEmpty', 'isNotEmpty'],
};

const VALUE_TYPE_BY_FIELD_TYPE: Record<FieldType, 'string' | 'number' | 'boolean'> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  date: 'string',
  enum: 'string',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well formed ISO calendar date that also exists (rejects 2024-02-31). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function quoteList(values: readonly string[], limit = 12): string {
  const shown = values.slice(0, limit).map((v) => `"${v}"`);
  if (values.length > shown.length) shown.push(`... and ${values.length - shown.length} more`);
  return shown.length > 0 ? shown.join(', ') : '(none)';
}

function describeValue(value: CellValue | undefined): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  return typeof value === 'string' ? `the string "${value}"` : `the ${typeof value} ${value}`;
}

/**
 * Runs every cross-reference rule over a structurally valid model.
 * Errors block acceptance. Warnings do not, but they are shown to the user and
 * passed back to the agent as hints on the next iteration.
 */
export function checkSemantics(model: ApplicationModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const entitiesById = new Map<string, Entity>();
  const entityIndexById = new Map<string, number>();

  model.entities.forEach((entity, entityIndex) => {
    const at = `entities[${entityIndex}]`;

    if (entitiesById.has(entity.id)) {
      issues.push(
        issue(
          `${at}.id`,
          'duplicate_entity_id',
          `Entity id "${entity.id}" is already used by another entity. Entity ids must be unique.`,
        ),
      );
    } else {
      entitiesById.set(entity.id, entity);
      entityIndexById.set(entity.id, entityIndex);
    }

    checkEntityFields(entity, at, issues);
    checkSeedRows(entity, at, issues);
  });

  const componentIds = new Set<string>();
  const referencedEntityIds = new Set<string>();

  model.components.forEach((component, componentIndex) => {
    const at = `components[${componentIndex}]`;

    if (componentIds.has(component.id)) {
      issues.push(
        issue(
          `${at}.id`,
          'duplicate_component_id',
          `Component id "${component.id}" is already used by another component. Component ids must be unique.`,
        ),
      );
    } else {
      componentIds.add(component.id);
    }

    if (component.type === 'text') return;

    const entity = entitiesById.get(component.entityId);
    if (!entity) {
      issues.push(
        issue(
          `${at}.entityId`,
          'unknown_entity',
          `No entity with id "${component.entityId}" exists. Declared entity ids are ${quoteList([
            ...entitiesById.keys(),
          ])}.`,
        ),
      );
      return;
    }
    referencedEntityIds.add(entity.id);

    switch (component.type) {
      case 'table':
        checkTable(component, entity, at, issues);
        break;
      case 'form':
        checkForm(component, entity, at, issues);
        break;
      case 'metric':
        checkMetric(component, entity, at, issues);
        break;
    }
  });

  for (const entity of model.entities) {
    if (!referencedEntityIds.has(entity.id)) {
      issues.push(
        issue(
          `entities[${entityIndexById.get(entity.id) ?? 0}].id`,
          'entity_not_displayed',
          `Entity "${entityPluralName(entity)}" is never shown by any component. Add a table, form or metric for it, or remove the entity.`,
          'warning',
        ),
      );
    }
  }

  if (model.layout.type === 'vertical' && model.layout.columns !== undefined) {
    issues.push(
      issue(
        'layout.columns',
        'layout_columns_ignored',
        'The vertical layout ignores the columns setting. Use layout.type "grid" or remove layout.columns.',
        'warning',
      ),
    );
  }

  return issues;
}

function checkEntityFields(entity: Entity, at: string, issues: ValidationIssue[]): void {
  const seen = new Set<string>();

  entity.fields.forEach((field, fieldIndex) => {
    const fieldAt = `${at}.fields[${fieldIndex}]`;

    if (seen.has(field.id)) {
      issues.push(
        issue(
          `${fieldAt}.id`,
          'duplicate_field_id',
          `Field id "${field.id}" appears twice on entity "${entity.id}". Field ids must be unique within an entity.`,
        ),
      );
    } else {
      seen.add(field.id);
    }

    if (field.type === 'enum') {
      if (!field.options || field.options.length === 0) {
        issues.push(
          issue(
            `${fieldAt}.options`,
            'enum_options_missing',
            `Field "${field.id}" has type "enum" so it must list its allowed values in options.`,
          ),
        );
      } else {
        const duplicates = field.options.filter(
          (option, index) => field.options?.indexOf(option) !== index,
        );
        if (duplicates.length > 0) {
          issues.push(
            issue(
              `${fieldAt}.options`,
              'duplicate_enum_option',
              `Field "${field.id}" repeats the option ${quoteList([...new Set(duplicates)])}. Each option must appear once.`,
            ),
          );
        }
      }
    } else if (field.options !== undefined) {
      issues.push(
        issue(
          `${fieldAt}.options`,
          'options_not_allowed',
          `Field "${field.id}" has type "${field.type}", so it must not declare options. Change the type to "enum" or remove options.`,
        ),
      );
    }
  });
}

function checkSeedRows(entity: Entity, at: string, issues: ValidationIssue[]): void {
  if (!entity.seed || entity.seed.length === 0) return;

  const fieldsById = new Map(entity.fields.map((f) => [f.id, f]));
  const knownIds = entity.fields.map((f) => f.id);

  entity.seed.forEach((row, rowIndex) => {
    const rowAt = `${at}.seed[${rowIndex}]`;

    for (const key of Object.keys(row)) {
      const field = fieldsById.get(key);
      if (!field) {
        issues.push(
          issue(
            `${rowAt}.${key}`,
            'seed_unknown_field',
            `Seed row uses "${key}", which is not a field on entity "${entity.id}". Known field ids are ${quoteList(knownIds)}.`,
          ),
        );
        continue;
      }
      checkCellValue(row[key] as CellValue, field, `${rowAt}.${key}`, issues);
    }

    for (const field of entity.fields) {
      if (!field.required) continue;
      const value = row[field.id];
      if (value === undefined || value === null || value === '') {
        issues.push(
          issue(
            `${rowAt}.${field.id}`,
            'seed_missing_required',
            `Field "${field.id}" is required, so every seed row must give it a value.`,
          ),
        );
      }
    }
  });
}

function checkCellValue(
  value: CellValue,
  field: Field,
  at: string,
  issues: ValidationIssue[],
): void {
  if (value === null) return; // Null means "not set", which is allowed for optional fields.

  const expected = VALUE_TYPE_BY_FIELD_TYPE[field.type];
  if (typeof value !== expected) {
    issues.push(
      issue(
        at,
        'seed_type_mismatch',
        `Field "${field.id}" has type "${field.type}" so its value must be ${
          expected === 'number' ? 'a number' : expected === 'boolean' ? 'a boolean' : 'a string'
        }, but the row contains ${describeValue(value)}.`,
      ),
    );
    return;
  }

  if (field.type === 'enum' && field.options && !field.options.includes(value as string)) {
    issues.push(
      issue(
        at,
        'seed_invalid_enum_value',
        `Value "${String(value)}" is not one of the options declared by field "${field.id}": ${quoteList(field.options)}.`,
      ),
    );
  }

  if (field.type === 'date' && !isIsoDate(value as string)) {
    issues.push(
      issue(
        at,
        'seed_invalid_date',
        `Field "${field.id}" has type "date" so its value must be a real calendar date in YYYY-MM-DD form, but the row contains ${describeValue(value)}.`,
      ),
    );
  }
}

function checkTable(
  component: Extract<ApplicationModel['components'][number], { type: 'table' }>,
  entity: Entity,
  at: string,
  issues: ValidationIssue[],
): void {
  const fieldsById = new Map(entity.fields.map((f) => [f.id, f]));
  const knownIds = entity.fields.map((f) => f.id);

  const seenColumns = new Set<string>();
  component.columns?.forEach((fieldId, index) => {
    if (!fieldsById.has(fieldId)) {
      issues.push(
        issue(
          `${at}.columns[${index}]`,
          'unknown_field',
          `Column "${fieldId}" is not a field on entity "${entity.id}". Known field ids are ${quoteList(knownIds)}.`,
        ),
      );
      return;
    }
    if (seenColumns.has(fieldId)) {
      issues.push(
        issue(
          `${at}.columns[${index}]`,
          'duplicate_column',
          `Column "${fieldId}" is listed more than once. Each column may appear only once.`,
        ),
      );
    }
    seenColumns.add(fieldId);
  });

  component.filters?.forEach((filter, index) => {
    const filterAt = `${at}.filters[${index}]`;
    const field = fieldsById.get(filter.fieldId);
    if (!field) {
      issues.push(
        issue(
          `${filterAt}.fieldId`,
          'unknown_field',
          `Filter targets "${filter.fieldId}", which is not a field on entity "${entity.id}". Known field ids are ${quoteList(knownIds)}.`,
        ),
      );
      return;
    }

    const selectable = field.type === 'enum' || field.type === 'boolean';
    if (filter.control === 'select' && !selectable) {
      issues.push(
        issue(
          `${filterAt}.control`,
          'filter_control_mismatch',
          `A "select" filter needs a field of type "enum" or "boolean", but "${field.id}" has type "${field.type}". Use control "text" instead.`,
        ),
      );
    }
    if (filter.control === 'text' && field.type !== 'string') {
      issues.push(
        issue(
          `${filterAt}.control`,
          'filter_control_mismatch',
          `A "text" filter needs a field of type "string", but "${field.id}" has type "${field.type}". Use control "select" instead.`,
        ),
      );
    }
  });

  if (component.where) {
    checkFilterExpression(component.where, entity, `${at}.where`, issues);
  }
}

function checkForm(
  component: Extract<ApplicationModel['components'][number], { type: 'form' }>,
  entity: Entity,
  at: string,
  issues: ValidationIssue[],
): void {
  const fieldsById = new Map(entity.fields.map((f) => [f.id, f]));
  const knownIds = entity.fields.map((f) => f.id);

  component.fieldIds?.forEach((fieldId, index) => {
    if (!fieldsById.has(fieldId)) {
      issues.push(
        issue(
          `${at}.fieldIds[${index}]`,
          'unknown_field',
          `Form field "${fieldId}" is not a field on entity "${entity.id}". Known field ids are ${quoteList(knownIds)}.`,
        ),
      );
    }
  });

  if (component.fieldIds && component.fieldIds.length > 0) {
    const collected = new Set(component.fieldIds);
    for (const field of entity.fields) {
      if (field.required && !collected.has(field.id)) {
        issues.push(
          issue(
            `${at}.fieldIds`,
            'form_missing_required_field',
            `Field "${field.id}" is required on entity "${entity.id}", so this form cannot create a valid row without collecting it.`,
          ),
        );
      }
    }
  }
}

function checkMetric(
  component: Extract<ApplicationModel['components'][number], { type: 'metric' }>,
  entity: Entity,
  at: string,
  issues: ValidationIssue[],
): void {
  const fieldsById = new Map(entity.fields.map((f) => [f.id, f]));
  const numericIds = entity.fields.filter((f) => f.type === 'number').map((f) => f.id);

  if (component.aggregate === 'count') {
    if (component.fieldId !== undefined) {
      issues.push(
        issue(
          `${at}.fieldId`,
          'metric_field_not_allowed',
          'The "count" aggregate counts rows and must not name a field. Remove fieldId, or pick a different aggregate.',
        ),
      );
    }
  } else if (component.fieldId === undefined) {
    issues.push(
      issue(
        `${at}.fieldId`,
        'metric_field_required',
        `The "${component.aggregate}" aggregate needs a numeric fieldId. Numeric fields on entity "${entity.id}" are ${quoteList(numericIds)}.`,
      ),
    );
  } else {
    const field = fieldsById.get(component.fieldId);
    if (!field) {
      issues.push(
        issue(
          `${at}.fieldId`,
          'unknown_field',
          `Metric reads "${component.fieldId}", which is not a field on entity "${entity.id}". Numeric field ids are ${quoteList(numericIds)}.`,
        ),
      );
    } else if (field.type !== 'number') {
      issues.push(
        issue(
          `${at}.fieldId`,
          'metric_field_not_numeric',
          `The "${component.aggregate}" aggregate needs a field of type "number", but "${field.id}" has type "${field.type}". Numeric field ids are ${quoteList(numericIds)}.`,
        ),
      );
    }
  }

  if (component.where) {
    checkFilterExpression(component.where, entity, `${at}.where`, issues);
  }
}

function checkFilterExpression(
  expression: FilterExpression,
  entity: Entity,
  at: string,
  issues: ValidationIssue[],
): void {
  expression.conditions.forEach((condition, index) => {
    checkCondition(condition, entity, `${at}.conditions[${index}]`, issues);
  });
}

function checkCondition(
  condition: Condition,
  entity: Entity,
  at: string,
  issues: ValidationIssue[],
): void {
  const field = entity.fields.find((f) => f.id === condition.fieldId);
  if (!field) {
    issues.push(
      issue(
        `${at}.fieldId`,
        'unknown_field',
        `Condition reads "${condition.fieldId}", which is not a field on entity "${entity.id}". Known field ids are ${quoteList(entity.fields.map((f) => f.id))}.`,
      ),
    );
    return;
  }

  const allowed = OPERATORS_BY_FIELD_TYPE[field.type];
  if (!allowed.includes(condition.op)) {
    issues.push(
      issue(
        `${at}.op`,
        'condition_operator_unsupported',
        `Operator "${condition.op}" cannot be used on field "${field.id}" of type "${field.type}". Allowed operators for this type are ${quoteList([...allowed])}.`,
      ),
    );
    return;
  }

  const binary = isBinaryOperator(condition.op);

  if (!binary) {
    if (condition.value !== undefined) {
      issues.push(
        issue(
          `${at}.value`,
          'condition_value_not_allowed',
          `Operator "${condition.op}" takes no value. Remove the value property.`,
        ),
      );
    }
    return;
  }

  if (condition.value === undefined || condition.value === null) {
    issues.push(
      issue(
        `${at}.value`,
        'condition_value_required',
        `Operator "${condition.op}" needs a value to compare "${field.id}" against.`,
      ),
    );
    return;
  }

  const expected = condition.op === 'contains' ? 'string' : VALUE_TYPE_BY_FIELD_TYPE[field.type];
  if (typeof condition.value !== expected) {
    issues.push(
      issue(
        `${at}.value`,
        'condition_value_type_mismatch',
        `Comparing field "${field.id}" of type "${field.type}" needs ${
          expected === 'number' ? 'a number' : expected === 'boolean' ? 'a boolean' : 'a string'
        }, but the condition uses ${describeValue(condition.value)}.`,
      ),
    );
    return;
  }

  if (
    field.type === 'enum' &&
    field.options &&
    !field.options.includes(condition.value as string)
  ) {
    issues.push(
      issue(
        `${at}.value`,
        'condition_enum_value_unknown',
        `Value "${String(condition.value)}" is not one of the options declared by field "${field.id}": ${quoteList(field.options)}.`,
      ),
    );
  }

  if (field.type === 'date' && !isIsoDate(condition.value as string)) {
    issues.push(
      issue(
        `${at}.value`,
        'condition_invalid_date',
        `Field "${field.id}" has type "date", so the comparison value must be a real calendar date in YYYY-MM-DD form.`,
      ),
    );
  }
}

/** Operators a field of the given type accepts. Exported for prompt documentation. */
export function operatorsForFieldType(type: FieldType): readonly ComparisonOperator[] {
  return OPERATORS_BY_FIELD_TYPE[type];
}
