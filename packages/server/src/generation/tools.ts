/**
 * The tools the agent loop offers, and their executors.
 *
 * Two decisions are worth explaining.
 *
 * Every argument is structured except two, which are passed as JSON text:
 * seed rows and filter expressions. Both have shapes that function-calling
 * implementations handle inconsistently, seed rows because their keys are field
 * ids the model chooses, filter values because they are string, number or
 * boolean depending on the field. Passing those two as strings keeps the tool
 * schema inside the subset every provider supports, and a string that does not
 * parse produces a precise error the model can act on, which is the same
 * feedback loop everything else here uses.
 *
 * create_entity and add_component replace an element that already has the same
 * id. That gives the model a way to fix its own mistakes without a separate
 * update tool, and it means a repeated call after a rejection does the right
 * thing rather than producing a duplicate id error.
 */
import {
  AGGREGATES,
  COMPARISON_OPERATORS,
  COMPONENT_TYPES,
  COMPONENT_WIDTHS,
  FIELD_TYPES,
  formatIssuesForPrompt,
  summariseIssues,
  type ValidationIssue,
} from '@nlam/shared';
import type { ToolCall, ToolDefinition } from '../providers/types.js';
import type { ModelDraft } from './draft.js';

export const TOOL_NAMES = [
  'plan',
  'create_entity',
  'set_seed_data',
  'add_component',
  'remove_component',
  'set_layout',
  'validate_model',
  'finalize',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const stringArray = { type: 'array', items: { type: 'string' } } as const;

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'plan',
      description:
        'Record the plan before building anything. Name the entities and the components you intend to create, in one short paragraph. Call this exactly once, first.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One paragraph naming the entities and components.',
          },
          appName: {
            type: 'string',
            description: 'Short title for the application, for example "Book tracker".',
          },
          appDescription: {
            type: 'string',
            description: 'One sentence describing what the application does.',
          },
        },
        required: ['summary', 'appName'],
      },
    },
    {
      name: 'create_entity',
      description:
        'Create one entity with its fields. Calling this again with the same id replaces the entity and keeps any rows already seeded, which is how you correct a rejected one.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Lowercase slug, for example "book".' },
          name: { type: 'string', description: 'Singular human label, for example "Book".' },
          pluralName: { type: 'string', description: 'Plural human label, for example "Books".' },
          fields: {
            type: 'array',
            description: 'One to sixteen fields.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Lowercase slug, unique within the entity.' },
                label: { type: 'string' },
                type: { type: 'string', enum: [...FIELD_TYPES] },
                required: { type: 'boolean' },
                options: {
                  ...stringArray,
                  description: 'Allowed values. Required for type "enum", forbidden otherwise.',
                },
              },
              required: ['id', 'label', 'type'],
            },
          },
        },
        required: ['id', 'name', 'fields'],
      },
    },
    {
      name: 'set_seed_data',
      description:
        'Give an entity three to six realistic example rows so the rendered application is not empty. Replaces any rows already set.',
      parameters: {
        type: 'object',
        properties: {
          entityId: { type: 'string' },
          rowsJson: {
            type: 'string',
            description:
              'A JSON array of objects keyed by field id, for example [{"title":"Piranesi","pages":245,"finished":false}]. Numbers and booleans must be JSON numbers and booleans, not strings. Dates are "YYYY-MM-DD".',
          },
        },
        required: ['entityId', 'rowsJson'],
      },
    },
    {
      name: 'add_component',
      description:
        'Add one component. Only the properties that belong to the chosen type are read. Calling this again with the same id replaces the component, which is how you correct a rejected one.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Lowercase slug, unique across components.' },
          type: { type: 'string', enum: [...COMPONENT_TYPES] },
          title: { type: 'string' },
          width: {
            type: 'string',
            enum: [...COMPONENT_WIDTHS],
            description: 'Honoured by the grid layout.',
          },
          entityId: { type: 'string', description: 'Required for table, form and metric.' },
          columns: {
            ...stringArray,
            description: 'table: field ids to show, in order. Defaults to all fields.',
          },
          filters: {
            type: 'array',
            description:
              'table: interactive controls. "select" needs an enum or boolean field, "text" needs a string field.',
            items: {
              type: 'object',
              properties: {
                fieldId: { type: 'string' },
                control: { type: 'string', enum: ['select', 'text'] },
                label: { type: 'string' },
              },
              required: ['fieldId', 'control'],
            },
          },
          emptyMessage: { type: 'string', description: 'table: shown when no rows match.' },
          fieldIds: {
            ...stringArray,
            description: 'form: field ids to collect. Must include every required field.',
          },
          submitLabel: { type: 'string', description: 'form: button text.' },
          aggregate: {
            type: 'string',
            enum: [...AGGREGATES],
            description:
              'metric: "count" counts rows, every other aggregate needs a numeric fieldId.',
          },
          fieldId: {
            type: 'string',
            description: 'metric: numeric field to aggregate. Omit for "count".',
          },
          caption: { type: 'string', description: 'metric: short line under the number.' },
          content: { type: 'string', description: 'text: the paragraph to display.' },
          whereJson: {
            type: 'string',
            description: `table and metric: a JSON filter, for example {"combinator":"and","conditions":[{"fieldId":"finished","op":"isFalse"}]}. Operators: ${COMPARISON_OPERATORS.join(', ')}. The unary operators isEmpty, isNotEmpty, isTrue and isFalse take no value.`,
          },
        },
        required: ['id', 'type'],
      },
    },
    {
      name: 'remove_component',
      description: 'Remove a component that is no longer wanted.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'set_layout',
      description: 'Choose how components are arranged. Defaults to a vertical layout.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['vertical', 'grid'] },
          columns: { type: 'number', description: 'grid only: 1 to 3.' },
        },
        required: ['type'],
      },
    },
    {
      name: 'validate_model',
      description: 'Check the whole draft and report any remaining errors.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'finalize',
      description: 'Accept the model. Only succeeds when validate_model reports no errors.',
      parameters: { type: 'object', properties: {} },
    },
  ];
}

export interface ToolExecution {
  name: string;
  ok: boolean;
  /** Text returned to the model as the tool result. */
  content: string;
  /** Short human-readable summary for the trace shown in the browser. */
  label: string;
  /** True only when finalize accepted the model. */
  finished: boolean;
  issues: ValidationIssue[];
}

export function executeTool(draft: ModelDraft, call: ToolCall): ToolExecution {
  const args = call.arguments ?? {};

  switch (call.name as ToolName) {
    case 'plan':
      return runPlan(draft, args);
    case 'create_entity':
      return runCreateEntity(draft, args);
    case 'set_seed_data':
      return runSetSeedData(draft, args);
    case 'add_component':
      return runAddComponent(draft, args);
    case 'remove_component':
      return runRemoveComponent(draft, args);
    case 'set_layout':
      return runSetLayout(draft, args);
    case 'validate_model':
      return runValidate(draft);
    case 'finalize':
      return runFinalize(draft);
    default:
      return {
        name: call.name,
        ok: false,
        finished: false,
        issues: [],
        label: `Unknown tool "${call.name}".`,
        content: `There is no tool called "${call.name}". Available tools are ${TOOL_NAMES.join(', ')}.`,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Executors                                                                  */
/* -------------------------------------------------------------------------- */

function runPlan(draft: ModelDraft, args: Record<string, unknown>): ToolExecution {
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (summary === '') {
    return rejected('plan', 'Plan rejected.', 'The summary must not be empty.');
  }

  draft.setPlan(
    summary,
    typeof args.appName === 'string' ? args.appName : undefined,
    typeof args.appDescription === 'string' ? args.appDescription : undefined,
  );

  return {
    name: 'plan',
    ok: true,
    finished: false,
    issues: [],
    label: 'Planned the application.',
    content: 'OK. Now create the entities.',
  };
}

function runCreateEntity(draft: ModelDraft, args: Record<string, unknown>): ToolExecution {
  const outcome = draft.createEntity(stripUndefined(args));
  const id = typeof args.id === 'string' ? args.id : '(unnamed)';

  if (!outcome.ok) {
    return rejectedWithIssues('create_entity', `Entity "${id}" rejected.`, outcome.issues);
  }

  const fieldCount = Array.isArray(args.fields) ? args.fields.length : 0;
  return {
    name: 'create_entity',
    ok: true,
    finished: false,
    issues: [],
    label: `Created entity "${id}" with ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}.`,
    content: `OK. Entity "${id}" now has ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}.`,
  };
}

function runSetSeedData(draft: ModelDraft, args: Record<string, unknown>): ToolExecution {
  const entityId = typeof args.entityId === 'string' ? args.entityId : '';
  const parsed = parseJsonArgument(args.rowsJson, 'rowsJson');

  if ('error' in parsed) {
    return rejected('set_seed_data', `Seed data for "${entityId}" rejected.`, parsed.error);
  }
  if (!Array.isArray(parsed.value)) {
    return rejected(
      'set_seed_data',
      `Seed data for "${entityId}" rejected.`,
      'rowsJson must contain a JSON array of row objects.',
    );
  }

  const outcome = draft.setSeedData(entityId, parsed.value);
  if (!outcome.ok) {
    return rejectedWithIssues(
      'set_seed_data',
      `Seed data for "${entityId}" rejected.`,
      outcome.issues,
    );
  }

  const count = parsed.value.length;
  return {
    name: 'set_seed_data',
    ok: true,
    finished: false,
    issues: [],
    label: `Seeded "${entityId}" with ${count} ${count === 1 ? 'row' : 'rows'}.`,
    content: `OK. Entity "${entityId}" now has ${count} seed ${count === 1 ? 'row' : 'rows'}.`,
  };
}

function runAddComponent(draft: ModelDraft, args: Record<string, unknown>): ToolExecution {
  const id = typeof args.id === 'string' ? args.id : '(unnamed)';
  const { whereJson, ...rest } = args;

  const component: Record<string, unknown> = stripUndefined(rest);

  if (whereJson !== undefined && whereJson !== null && whereJson !== '') {
    const parsed = parseJsonArgument(whereJson, 'whereJson');
    if ('error' in parsed) {
      return rejected('add_component', `Component "${id}" rejected.`, parsed.error);
    }
    component.where = parsed.value;
  }

  const outcome = draft.addComponent(component);
  if (!outcome.ok) {
    return rejectedWithIssues('add_component', `Component "${id}" rejected.`, outcome.issues);
  }

  const type = typeof args.type === 'string' ? args.type : 'component';
  return {
    name: 'add_component',
    ok: true,
    finished: false,
    issues: [],
    label: `Added ${type} "${id}".`,
    content: `OK. Component "${id}" added.`,
  };
}

function runRemoveComponent(draft: ModelDraft, args: Record<string, unknown>): ToolExecution {
  const outcome = draft.removeComponent(args.id);
  const id = typeof args.id === 'string' ? args.id : '(unnamed)';

  if (!outcome.ok) {
    return rejectedWithIssues('remove_component', `Could not remove "${id}".`, outcome.issues);
  }
  return {
    name: 'remove_component',
    ok: true,
    finished: false,
    issues: [],
    label: `Removed component "${id}".`,
    content: `OK. Component "${id}" removed.`,
  };
}

function runSetLayout(draft: ModelDraft, args: Record<string, unknown>): ToolExecution {
  const outcome = draft.setLayout(stripUndefined(args));
  if (!outcome.ok) {
    return rejectedWithIssues('set_layout', 'Layout rejected.', outcome.issues);
  }
  return {
    name: 'set_layout',
    ok: true,
    finished: false,
    issues: [],
    label: `Set a ${String(args.type)} layout.`,
    content: 'OK. Layout set.',
  };
}

function runValidate(draft: ModelDraft): ToolExecution {
  const validation = draft.validate();

  if (validation.ok) {
    const warnings =
      validation.warnings.length > 0
        ? `\n\nWarnings, which do not block acceptance:\n${validation.warnings
            .map((issue, index) => `${index + 1}. at ${issue.path}: ${issue.message}`)
            .join('\n')}`
        : '';

    return {
      name: 'validate_model',
      ok: true,
      finished: false,
      issues: validation.warnings,
      label: 'Validated the draft: no errors.',
      content: `The model is valid. Call finalize to accept it.${warnings}`,
    };
  }

  return {
    name: 'validate_model',
    ok: false,
    finished: false,
    issues: validation.errors,
    label: `Validated the draft: ${summariseIssues(validation.issues)}.`,
    content: `The model is not valid yet. Fix these:\n\n${formatIssuesForPrompt(validation.errors)}`,
  };
}

function runFinalize(draft: ModelDraft): ToolExecution {
  const validation = draft.validate();

  if (!validation.ok) {
    return {
      name: 'finalize',
      ok: false,
      finished: false,
      issues: validation.errors,
      label: `Refused to finalize: ${summariseIssues(validation.issues)}.`,
      content: `Cannot finalize while the model has errors. Fix these and try again:\n\n${formatIssuesForPrompt(validation.errors)}`,
    };
  }

  return {
    name: 'finalize',
    ok: true,
    finished: true,
    issues: validation.warnings,
    label: 'Accepted the model.',
    content: 'Accepted.',
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function rejected(name: string, label: string, detail: string): ToolExecution {
  return {
    name,
    ok: false,
    finished: false,
    issues: [{ path: '(arguments)', code: 'invalid_argument', severity: 'error', message: detail }],
    label,
    content: `Rejected. ${detail}`,
  };
}

function rejectedWithIssues(
  name: string,
  label: string,
  issues: readonly ValidationIssue[],
): ToolExecution {
  return {
    name,
    ok: false,
    finished: false,
    issues: [...issues],
    label: `${label} ${summariseIssues(issues)}.`,
    content: `Rejected. Fix these and call the tool again:\n\n${formatIssuesForPrompt(issues)}`,
  };
}

function parseJsonArgument(raw: unknown, name: string): { value: unknown } | { error: string } {
  if (typeof raw !== 'string') {
    return { error: `${name} must be a JSON string, but it arrived as ${typeof raw}.` };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `${name} is not valid JSON: ${detail}` };
  }
}

/**
 * Providers often send optional arguments as explicit nulls. The schema
 * distinguishes "absent" from "null", so they are stripped here rather than
 * being reported back as type errors the model cannot do anything about.
 */
function stripUndefined(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
