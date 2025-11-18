/**
 * The application model schema.
 *
 * This is the contract between the generator and the renderer. Everything the
 * language model produces has to fit here, and everything the React client
 * renders is read from here. Two properties matter more than expressiveness:
 *
 * 1. It is closed. Every object rejects unknown keys, so a model that validates
 *    contains nothing the renderer cannot interpret.
 * 2. It is small. Derived values are expressed as a whitelisted set of
 *    aggregates over a whitelisted set of comparisons. There is no expression
 *    language to parse and no generated code to execute.
 *
 * Structural rules live here. Rules that need to look across the document
 * (does this component reference an entity that exists?) live in semantics.ts,
 * because Zod issues alone cannot express them with useful messages.
 */
import { z } from 'zod';

/**
 * Bumped when a change would make previously stored models invalid. The server
 * sets this field itself, so the generator never has to produce it.
 */
export const SCHEMA_VERSION = '1.0.0';

/** Machine-facing names: lowercase, underscore separated, stable across label renames. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

const identifier = z
  .string()
  .min(1, 'Identifier must not be empty.')
  .max(48, 'Identifier must be 48 characters or fewer.')
  .regex(
    IDENTIFIER_PATTERN,
    'Identifier must start with a lowercase letter and contain only lowercase letters, digits and underscores.',
  );

const label = z
  .string()
  .min(1, 'Label must not be empty.')
  .max(80, 'Label must be 80 characters or fewer.');

/* -------------------------------------------------------------------------- */
/* Data model                                                                 */
/* -------------------------------------------------------------------------- */

export const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'enum'] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES);

export const FieldSchema = z.strictObject({
  id: identifier,
  label,
  type: FieldTypeSchema,
  /** Required fields must be supplied by seed rows and marked required in forms. */
  required: z.boolean().default(false),
  /** Allowed values. Mandatory for enum fields, forbidden for every other type. */
  options: z
    .array(z.string().min(1, 'Enum options must not be empty strings.'))
    .min(1, 'An enum field needs at least one option.')
    .max(24, 'An enum field may declare at most 24 options.')
    .optional(),
});

/** Values a stored cell may hold. Dates are ISO calendar strings, not Date objects. */
export const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const SeedRowSchema = z.record(z.string(), CellValueSchema);

export const EntitySchema = z.strictObject({
  id: identifier,
  /** Singular human label, for example "Book". */
  name: label,
  /** Plural human label. Defaults to name plus "s" when omitted. */
  pluralName: label.optional(),
  fields: z
    .array(FieldSchema)
    .min(1, 'An entity needs at least one field.')
    .max(16, 'An entity may declare at most 16 fields.'),
  seed: z.array(SeedRowSchema).max(50, 'An entity may seed at most 50 rows.').optional(),
});

/* -------------------------------------------------------------------------- */
/* Derived logic                                                              */
/* -------------------------------------------------------------------------- */

export const COMPARISON_OPERATORS = [
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'contains',
  'isEmpty',
  'isNotEmpty',
  'isTrue',
  'isFalse',
] as const;
export const ComparisonOperatorSchema = z.enum(COMPARISON_OPERATORS);

/** Operators that read the value property. Everything else is unary. */
export const BINARY_OPERATORS = [
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'contains',
] as const;

export const ConditionSchema = z.strictObject({
  fieldId: identifier,
  op: ComparisonOperatorSchema,
  /** Omitted for the unary operators (isEmpty, isNotEmpty, isTrue, isFalse). */
  value: CellValueSchema.optional(),
});

/**
 * A flat list of conditions joined by a single combinator. Deliberately not
 * recursive: one level covers the filters these applications need, and it keeps
 * both the repair messages and the renderer trivial to reason about.
 */
export const FilterExpressionSchema = z.strictObject({
  combinator: z.enum(['and', 'or']).default('and'),
  conditions: z
    .array(ConditionSchema)
    .min(1, 'A filter needs at least one condition.')
    .max(8, 'A filter may combine at most 8 conditions.'),
});

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

export const COMPONENT_WIDTHS = ['full', 'half', 'third'] as const;

const componentBase = z.strictObject({
  id: identifier,
  title: label.optional(),
  /** Honoured by the grid layout, ignored by the vertical layout. */
  width: z.enum(COMPONENT_WIDTHS).default('full'),
});

export const TableFilterSchema = z.strictObject({
  fieldId: identifier,
  /** "select" suits enum and boolean fields, "text" suits string fields. */
  control: z.enum(['select', 'text']),
  label: label.optional(),
});

export const TableComponentSchema = componentBase.extend({
  type: z.literal('table'),
  entityId: identifier,
  /** Field ids to show, in order. All fields are shown when omitted. */
  columns: z.array(identifier).max(16, 'A table may show at most 16 columns.').optional(),
  /** Interactive controls rendered above the table. */
  filters: z
    .array(TableFilterSchema)
    .max(4, 'A table may offer at most 4 filter controls.')
    .optional(),
  /** Applied before any interactive filter, so a table can show a fixed subset. */
  where: FilterExpressionSchema.optional(),
  emptyMessage: z.string().max(160, 'Empty message must be 160 characters or fewer.').optional(),
});

export const FormComponentSchema = componentBase.extend({
  type: z.literal('form'),
  entityId: identifier,
  /** Field ids to collect, in order. All fields are collected when omitted. */
  fieldIds: z.array(identifier).max(16, 'A form may collect at most 16 fields.').optional(),
  submitLabel: label.optional(),
});

export const AGGREGATES = ['count', 'sum', 'average', 'min', 'max'] as const;
export const AggregateSchema = z.enum(AGGREGATES);

export const MetricComponentSchema = componentBase.extend({
  type: z.literal('metric'),
  entityId: identifier,
  aggregate: AggregateSchema,
  /** Required by every aggregate except count, which counts rows. */
  fieldId: identifier.optional(),
  /** Restricts the rows the aggregate reads. */
  where: FilterExpressionSchema.optional(),
  /** Rendered under the number, for example "still unread". */
  caption: z.string().max(80, 'Caption must be 80 characters or fewer.').optional(),
});

export const TextComponentSchema = componentBase.extend({
  type: z.literal('text'),
  content: z
    .string()
    .min(1, 'Text content must not be empty.')
    .max(600, 'Text content must be 600 characters or fewer.'),
});

export const ComponentSchema = z.discriminatedUnion('type', [
  TableComponentSchema,
  FormComponentSchema,
  MetricComponentSchema,
  TextComponentSchema,
]);

export const COMPONENT_TYPES = ['table', 'form', 'metric', 'text'] as const;

/* -------------------------------------------------------------------------- */
/* Document                                                                   */
/* -------------------------------------------------------------------------- */

export const LayoutSchema = z.strictObject({
  type: z.enum(['vertical', 'grid']).default('vertical'),
  /** Grid column count. Ignored by the vertical layout. */
  columns: z
    .number()
    .int('Column count must be a whole number.')
    .min(1, 'A grid needs at least 1 column.')
    .max(3, 'A grid may have at most 3 columns.')
    .optional(),
});

export const ApplicationModelSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION, `schemaVersion must be "${SCHEMA_VERSION}".`),
  app: z.strictObject({
    name: label,
    description: z.string().max(240, 'Description must be 240 characters or fewer.').optional(),
  }),
  entities: z
    .array(EntitySchema)
    .min(1, 'An application needs at least one entity.')
    .max(6, 'An application may declare at most 6 entities.'),
  /** Rendered in array order. */
  components: z
    .array(ComponentSchema)
    .min(1, 'An application needs at least one component.')
    .max(12, 'An application may declare at most 12 components.'),
  layout: LayoutSchema.default({ type: 'vertical' }),
});

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type FieldType = z.infer<typeof FieldTypeSchema>;
export type Field = z.infer<typeof FieldSchema>;
export type CellValue = z.infer<typeof CellValueSchema>;
export type SeedRow = z.infer<typeof SeedRowSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type ComparisonOperator = z.infer<typeof ComparisonOperatorSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type FilterExpression = z.infer<typeof FilterExpressionSchema>;
export type TableFilter = z.infer<typeof TableFilterSchema>;
export type TableComponent = z.infer<typeof TableComponentSchema>;
export type FormComponent = z.infer<typeof FormComponentSchema>;
export type MetricComponent = z.infer<typeof MetricComponentSchema>;
export type TextComponent = z.infer<typeof TextComponentSchema>;
export type Component = z.infer<typeof ComponentSchema>;
export type ComponentType = Component['type'];
export type Aggregate = z.infer<typeof AggregateSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type ApplicationModel = z.infer<typeof ApplicationModelSchema>;

/** The shape accepted as input, before defaults are applied. */
export type ApplicationModelInput = z.input<typeof ApplicationModelSchema>;

/** True when the operator reads the value property. */
export function isBinaryOperator(op: ComparisonOperator): boolean {
  return (BINARY_OPERATORS as readonly string[]).includes(op);
}

/** Plural label for an entity, falling back to a naive plural of the singular. */
export function entityPluralName(entity: Entity): string {
  return entity.pluralName ?? `${entity.name}s`;
}
