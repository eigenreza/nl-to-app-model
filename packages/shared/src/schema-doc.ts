/**
 * The schema, described for a language model.
 *
 * This text is part of the prompt, so it lives next to the schema rather than
 * in the server package, and the parts that can drift (field types, operators,
 * aggregates) are generated from the same constants the validator uses. A
 * hand-maintained copy of this document would be wrong within a week.
 */
import {
  AGGREGATES,
  COMPONENT_TYPES,
  COMPONENT_WIDTHS,
  FIELD_TYPES,
  SCHEMA_VERSION,
} from './model.js';
import { operatorsForFieldType } from './semantics.js';
import { EXAMPLE_MODELS } from './examples.js';

function list(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

const operatorTable = FIELD_TYPES.map(
  (type) => `  - ${type}: ${list([...operatorsForFieldType(type)])}`,
).join('\n');

/** Full reference. Used by the planner step, where context budget is not tight. */
export const SCHEMA_GUIDE = `# Application model reference

An application model is a JSON document describing a small single-page
application: its data, the components that display that data, and a layout.
Schema version ${SCHEMA_VERSION}. Unknown properties are rejected everywhere, so
never invent a property that is not listed below.

## Identifiers

Every id (entities, fields, components) matches ^[a-z][a-z0-9_]*$: lowercase
letters, digits and underscores, starting with a letter. Ids are for machines.
Human wording goes in "label", "name" and "title".

## Entities

An entity is one table of data.

  {
    "id": "book",
    "name": "Book",                  // singular label
    "pluralName": "Books",           // optional
    "fields": [ ... ],               // 1 to 16
    "seed": [ { ... } ]              // optional, up to 50 example rows
  }

A field is:

  { "id": "genre", "label": "Genre", "type": "enum", "required": false,
    "options": ["Fiction", "Nonfiction"] }

Field types: ${list(FIELD_TYPES)}.
  - "options" is mandatory for "enum" and forbidden for every other type.
  - "date" values are ISO calendar strings, "2024-03-19".
  - "number" values are JSON numbers, never strings.
  - Seed rows use field ids as keys. Every required field must be present in
    every seed row.

## Components

Components render in array order. Every component has "id", an optional
"title", and an optional "width" (${list(COMPONENT_WIDTHS)}, honoured by the
grid layout only). Component types: ${list(COMPONENT_TYPES)}.

  table:  { "id": "book_table", "type": "table", "entityId": "book",
            "columns": ["title", "genre"],          // optional, defaults to all fields
            "filters": [ { "fieldId": "genre", "control": "select", "label": "Genre" } ],
            "where": { ... },                        // optional fixed filter
            "emptyMessage": "No books yet." }        // optional

          A "select" filter needs an enum or boolean field.
          A "text" filter needs a string field.

  form:   { "id": "add_book", "type": "form", "entityId": "book",
            "fieldIds": ["title", "genre"],          // optional, defaults to all fields
            "submitLabel": "Add book" }

          If "fieldIds" is given it must include every required field.

  metric: { "id": "unread", "type": "metric", "entityId": "book",
            "aggregate": "count",                    // ${list(AGGREGATES)}
            "fieldId": "pages",                      // required except for "count"
            "where": { ... },                        // optional
            "caption": "not finished yet" }          // optional

          "count" counts rows and must not name a field. Every other aggregate
          needs a "fieldId" pointing at a field of type "number".

  text:   { "id": "intro", "type": "text", "title": "This week",
            "content": "Short explanatory paragraph." }

## Filters

A filter is a flat list of conditions joined by one combinator. It does not
nest.

  { "combinator": "and",          // "and" (default) or "or"
    "conditions": [ { "fieldId": "finished", "op": "isFalse" } ] }

A condition is { "fieldId", "op", "value" }. The operators
"isEmpty", "isNotEmpty", "isTrue" and "isFalse" take no "value". Every other
operator requires one, and its JSON type must match the field: a number for
"number" fields, a boolean for "boolean" fields, a string otherwise. Comparing
an enum field only accepts a value listed in that field's options.

Operators allowed per field type:
${operatorTable}

## Layout

  { "type": "vertical" }                 // one component per row
  { "type": "grid", "columns": 2 }       // 1 to 3 columns, widths honoured

## Limits

At most 6 entities, 12 components, 16 fields per entity, 8 conditions per
filter, 50 seed rows per entity.

## Worked example

${JSON.stringify(EXAMPLE_MODELS.contact_list, null, 2)}
`;

/**
 * Reference for a caller that reaches the schema through tools rather than by
 * writing a document.
 *
 * The tool definitions already carry every property name, type and enum, and
 * they are sent on the same request, so repeating them in the system prompt
 * buys nothing and costs the same tokens on every turn of every case. What the
 * tool schemas cannot express is the reasoning: which combinations are legal,
 * what the operators mean, and where the ceilings are. That is what this keeps.
 *
 * The worked example is dropped for the same reason. It shows a whole
 * hand-written document, which is precisely the thing a tool-using caller never
 * produces.
 */
export const SCHEMA_GUIDE_FOR_TOOLS = `# Application model rules

The tool definitions describe every property. These are the rules they cannot
state, and unknown properties are rejected everywhere, so never invent one.

## Identifiers

Every id (entities, fields, components) matches ^[a-z][a-z0-9_]*$. Ids are for
machines; human wording goes in "label", "name" and "title".

## Fields

Field types: ${list(FIELD_TYPES)}.
  - "options" is mandatory for "enum" and forbidden for every other type.
  - "date" values are ISO calendar strings, "2024-03-19", and must be real days.
  - "number" values are JSON numbers, never strings.
  - Seed rows are keyed by field id, and every required field must appear in
    every row.

## Components

  - A "select" table filter needs an enum or boolean field; a "text" filter
    needs a string field.
  - A form that lists fieldIds must include every required field, or it cannot
    create a valid row.
  - The "count" aggregate counts rows and must not name a field. Every other
    aggregate (${list(AGGREGATES.filter((a) => a !== 'count'))}) needs a fieldId
    pointing at a field of type "number".
  - Widths (${list(COMPONENT_WIDTHS)}) are honoured by the grid layout only.

## Filters

A filter is a flat list of conditions joined by one combinator, "and" or "or".
It does not nest. "isEmpty", "isNotEmpty", "isTrue" and "isFalse" take no value;
every other operator requires one whose JSON type matches the field, and an enum
comparison only accepts a value listed in that field's options.

Operators allowed per field type:
${operatorTable}

## Limits

At most 6 entities, 12 components, 16 fields per entity, 8 conditions per
filter, 50 seed rows per entity.
`;

/**
 * Condensed reference. Used on repair turns, where the conversation already
 * carries a draft model and the full guide would crowd out the errors.
 */
export const SCHEMA_GUIDE_BRIEF = `Application model, schema version ${SCHEMA_VERSION}. Unknown properties are rejected.
Ids match ^[a-z][a-z0-9_]*$. Field types: ${list(FIELD_TYPES)}; "options" only on "enum"; dates are "YYYY-MM-DD".
Components: ${list(COMPONENT_TYPES)}. Metrics use ${list(AGGREGATES)}; every aggregate except "count" needs a numeric "fieldId", and "count" must not have one.
Filters are { "combinator": "and" | "or", "conditions": [ { "fieldId", "op", "value" } ] } and do not nest.
Unary operators ("isEmpty", "isNotEmpty", "isTrue", "isFalse") take no value; all others require one whose JSON type matches the field.
Operators allowed per field type:
${operatorTable}`;
