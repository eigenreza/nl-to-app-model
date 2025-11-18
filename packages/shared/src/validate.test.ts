import { describe, expect, it } from 'vitest';
import { EXAMPLE_IDS, EXAMPLE_MODELS } from './examples.js';
import { SCHEMA_VERSION, type ApplicationModelInput } from './model.js';
import {
  validateApplicationModel,
  validateApplicationModelJson,
  withSchemaVersion,
} from './validate.js';

/** Smallest document that validates. Tests clone and break one thing at a time. */
function baseModel(): ApplicationModelInput {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: { name: 'Test app' },
    entities: [
      {
        id: 'task',
        name: 'Task',
        fields: [
          { id: 'title', label: 'Title', type: 'string', required: true },
          { id: 'done', label: 'Done', type: 'boolean' },
          { id: 'points', label: 'Points', type: 'number' },
          { id: 'due', label: 'Due', type: 'date' },
          { id: 'status', label: 'Status', type: 'enum', options: ['todo', 'doing'] },
        ],
        seed: [{ title: 'Write tests', done: false, points: 3, due: '2024-05-01', status: 'todo' }],
      },
    ],
    components: [{ id: 'task_table', type: 'table', entityId: 'task' }],
    layout: { type: 'vertical' },
  };
}

/** Applies a mutation to a fresh copy and returns the error codes it produces. */
function codesFor(mutate: (model: any) => void): string[] {
  const model = baseModel() as any;
  mutate(model);
  return validateApplicationModel(model).errors.map((issue) => issue.code);
}

describe('reference models', () => {
  it('exposes every example', () => {
    expect(EXAMPLE_IDS.length).toBeGreaterThanOrEqual(4);
  });

  it.each(EXAMPLE_IDS)('validates the %s example', (id) => {
    const validation = validateApplicationModel(EXAMPLE_MODELS[id]);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('leaves the examples free of warnings', () => {
    for (const id of EXAMPLE_IDS) {
      expect(validateApplicationModel(EXAMPLE_MODELS[id]).warnings).toEqual([]);
    }
  });
});

describe('structural validation', () => {
  it('accepts the base model and applies defaults', () => {
    const validation = validateApplicationModel(baseModel());
    expect(validation.ok).toBe(true);
    expect(validation.model?.entities[0]?.fields[1]?.required).toBe(false);
    expect(validation.model?.components[0]?.width).toBe('full');
  });

  it('rejects unknown properties and names them', () => {
    const model = baseModel() as any;
    model.components[0].sortBy = 'title';
    const validation = validateApplicationModel(model);
    expect(validation.ok).toBe(false);
    expect(validation.errors[0]?.code).toBe('unrecognized_key');
    expect(validation.errors[0]?.message).toContain('"sortBy"');
  });

  it('rejects a wrong schema version', () => {
    expect(codesFor((m) => (m.schemaVersion = '0.9'))).toContain('invalid_value');
  });

  it('rejects identifiers that are not lowercase slugs', () => {
    const validation = validateApplicationModel({
      ...baseModel(),
      entities: [
        {
          id: 'Task List',
          name: 'Task',
          fields: [{ id: 'title', label: 'Title', type: 'string' }],
        },
      ],
      components: [{ id: 'task_table', type: 'table', entityId: 'Task List' }],
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((i) => i.path === 'entities[0].id')).toBe(true);
  });

  it('reports the discriminator when the component type is unknown', () => {
    const validation = validateApplicationModel({
      ...baseModel(),
      components: [{ id: 'chart', type: 'chart', entityId: 'task' }],
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('requires at least one entity and one component', () => {
    expect(codesFor((m) => (m.entities = []))).toContain('too_small');
    expect(codesFor((m) => (m.components = []))).toContain('too_small');
  });
});

describe('cross reference validation', () => {
  it('rejects a component pointing at a missing entity', () => {
    const model = baseModel() as any;
    model.components[0].entityId = 'project';
    const validation = validateApplicationModel(model);
    expect(validation.errors[0]?.code).toBe('unknown_entity');
    expect(validation.errors[0]?.message).toContain('"task"');
  });

  it('rejects duplicate entity, field and component ids', () => {
    expect(codesFor((m) => m.entities.push({ ...m.entities[0] }))).toContain('duplicate_entity_id');
    expect(
      codesFor((m) => m.entities[0].fields.push({ id: 'title', label: 'Again', type: 'string' })),
    ).toContain('duplicate_field_id');
    expect(codesFor((m) => m.components.push({ ...m.components[0] }))).toContain(
      'duplicate_component_id',
    );
  });

  it('requires options on enum fields and forbids them elsewhere', () => {
    expect(codesFor((m) => delete m.entities[0].fields[4].options)).toContain(
      'enum_options_missing',
    );
    expect(codesFor((m) => (m.entities[0].fields[0].options = ['a']))).toContain(
      'options_not_allowed',
    );
  });

  it('checks seed rows against their fields', () => {
    expect(codesFor((m) => (m.entities[0].seed[0].colour = 'red'))).toContain('seed_unknown_field');
    expect(codesFor((m) => (m.entities[0].seed[0].points = '3'))).toContain('seed_type_mismatch');
    expect(codesFor((m) => (m.entities[0].seed[0].status = 'archived'))).toContain(
      'seed_invalid_enum_value',
    );
    expect(codesFor((m) => (m.entities[0].seed[0].due = '2024-02-31'))).toContain(
      'seed_invalid_date',
    );
    expect(codesFor((m) => delete m.entities[0].seed[0].title)).toContain('seed_missing_required');
  });

  it('checks table columns and filter controls', () => {
    expect(codesFor((m) => (m.components[0].columns = ['title', 'owner']))).toContain(
      'unknown_field',
    );
    expect(codesFor((m) => (m.components[0].columns = ['title', 'title']))).toContain(
      'duplicate_column',
    );
    expect(
      codesFor((m) => (m.components[0].filters = [{ fieldId: 'points', control: 'select' }])),
    ).toContain('filter_control_mismatch');
    expect(
      codesFor((m) => (m.components[0].filters = [{ fieldId: 'status', control: 'text' }])),
    ).toContain('filter_control_mismatch');
  });

  it('accepts a select filter on an enum or a boolean field', () => {
    expect(
      codesFor((m) => (m.components[0].filters = [{ fieldId: 'status', control: 'select' }])),
    ).toEqual([]);
    expect(
      codesFor((m) => (m.components[0].filters = [{ fieldId: 'done', control: 'select' }])),
    ).toEqual([]);
  });

  it('checks metric aggregates against field types', () => {
    const metric = (extra: Record<string, unknown>) => ({
      id: 'm',
      type: 'metric',
      entityId: 'task',
      ...extra,
    });
    expect(codesFor((m) => m.components.push(metric({ aggregate: 'sum' })))).toContain(
      'metric_field_required',
    );
    expect(
      codesFor((m) => m.components.push(metric({ aggregate: 'sum', fieldId: 'title' }))),
    ).toContain('metric_field_not_numeric');
    expect(
      codesFor((m) => m.components.push(metric({ aggregate: 'count', fieldId: 'points' }))),
    ).toContain('metric_field_not_allowed');
    expect(
      codesFor((m) => m.components.push(metric({ aggregate: 'sum', fieldId: 'points' }))),
    ).toEqual([]);
  });

  it('requires forms to collect every required field', () => {
    expect(
      codesFor((m) =>
        m.components.push({ id: 'f', type: 'form', entityId: 'task', fieldIds: ['done'] }),
      ),
    ).toContain('form_missing_required_field');
  });

  it('checks conditions against the operator whitelist', () => {
    const where = (condition: unknown) => (m: any) => {
      m.components[0].where = { conditions: [condition] };
    };
    expect(codesFor(where({ fieldId: 'nope', op: 'isTrue' }))).toContain('unknown_field');
    expect(codesFor(where({ fieldId: 'done', op: 'contains', value: 'x' }))).toContain(
      'condition_operator_unsupported',
    );
    expect(codesFor(where({ fieldId: 'points', op: 'greaterThan' }))).toContain(
      'condition_value_required',
    );
    expect(codesFor(where({ fieldId: 'done', op: 'isTrue', value: true }))).toContain(
      'condition_value_not_allowed',
    );
    expect(codesFor(where({ fieldId: 'points', op: 'greaterThan', value: '3' }))).toContain(
      'condition_value_type_mismatch',
    );
    expect(codesFor(where({ fieldId: 'status', op: 'equals', value: 'archived' }))).toContain(
      'condition_enum_value_unknown',
    );
    expect(codesFor(where({ fieldId: 'due', op: 'lessThan', value: 'yesterday' }))).toContain(
      'condition_invalid_date',
    );
    expect(codesFor(where({ fieldId: 'points', op: 'greaterThanOrEqual', value: 3 }))).toEqual([]);
  });
});

describe('warnings', () => {
  it('flags an entity that nothing displays without failing validation', () => {
    const model = baseModel() as any;
    model.entities.push({
      id: 'note',
      name: 'Note',
      fields: [{ id: 'body', label: 'Body', type: 'string' }],
    });
    const validation = validateApplicationModel(model);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.map((w) => w.code)).toContain('entity_not_displayed');
  });

  it('flags grid columns on a vertical layout', () => {
    const model = baseModel() as any;
    model.layout = { type: 'vertical', columns: 2 };
    const validation = validateApplicationModel(model);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.map((w) => w.code)).toContain('layout_columns_ignored');
  });
});

describe('json entry point', () => {
  it('reports a syntax error as an ordinary issue', () => {
    const validation = validateApplicationModelJson('{ "app": ');
    expect(validation.ok).toBe(false);
    expect(validation.errors[0]?.code).toBe('invalid_json');
  });

  it('validates well formed json', () => {
    expect(validateApplicationModelJson(JSON.stringify(baseModel())).ok).toBe(true);
  });
});

describe('withSchemaVersion', () => {
  it('stamps the current version onto an object', () => {
    expect(withSchemaVersion({ app: {} })).toEqual({ app: {}, schemaVersion: SCHEMA_VERSION });
  });

  it('leaves non-objects alone', () => {
    expect(withSchemaVersion(null)).toBeNull();
    expect(withSchemaVersion([1])).toEqual([1]);
  });
});
