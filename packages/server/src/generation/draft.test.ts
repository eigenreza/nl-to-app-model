import { beforeEach, describe, expect, it } from 'vitest';
import { ModelDraft } from './draft.js';

const bookEntity = {
  id: 'book',
  name: 'Book',
  pluralName: 'Books',
  fields: [
    { id: 'title', label: 'Title', type: 'string', required: true },
    { id: 'genre', label: 'Genre', type: 'enum', options: ['Fiction', 'History'] },
    { id: 'pages', label: 'Pages', type: 'number' },
    { id: 'finished', label: 'Finished', type: 'boolean' },
  ],
};

/** Deliberately leaves "pages" unset, which is allowed for an optional field. */
const seedRows = [
  { title: 'Piranesi', genre: 'Fiction', finished: false },
  { title: 'The Making of the Atomic Bomb', genre: 'History', finished: true },
];

let draft: ModelDraft;

beforeEach(() => {
  draft = new ModelDraft();
});

describe('entities', () => {
  it('accepts a well formed entity', () => {
    expect(draft.createEntity(bookEntity)).toEqual({ ok: true, issues: [] });
    expect(draft.entityIds).toEqual(['book']);
  });

  it('reports issues relative to the entity, not to the whole document', () => {
    const outcome = draft.createEntity({
      ...bookEntity,
      fields: [{ id: 'genre', label: 'Genre', type: 'enum' }],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]?.path).toBe('fields[0].options');
    expect(outcome.issues[0]?.code).toBe('enum_options_missing');
  });

  it('rejects an identifier that is not a slug', () => {
    const outcome = draft.createEntity({ ...bookEntity, id: 'Book List' });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]?.path).toBe('id');
    expect(draft.entityIds).toEqual([]);
  });

  it('replaces an entity that has the same id instead of duplicating it', () => {
    draft.createEntity(bookEntity);
    draft.createEntity({ ...bookEntity, name: 'Volume' });

    expect(draft.entityIds).toEqual(['book']);
    const snapshot = draft.snapshot() as { entities: Array<{ name: string }> };
    expect(snapshot.entities[0]?.name).toBe('Volume');
  });
});

describe('seed data', () => {
  beforeEach(() => {
    draft.createEntity(bookEntity);
  });

  it('accepts rows that match the field types', () => {
    expect(draft.setSeedData('book', seedRows)).toEqual({ ok: true, issues: [] });
  });

  it('names the created entities when the target does not exist', () => {
    const outcome = draft.setSeedData('author', seedRows);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]?.message).toContain('"book"');
  });

  it('points at the offending cell when a value has the wrong type', () => {
    const outcome = draft.setSeedData('book', [{ title: 'x', pages: 'many' }]);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]?.path).toBe('seed[0].pages');
    expect(outcome.issues[0]?.code).toBe('seed_type_mismatch');
  });

  it('rejects an enum value that is not one of the options', () => {
    const outcome = draft.setSeedData('book', [{ title: 'x', genre: 'Poetry' }]);
    expect(outcome.issues[0]?.code).toBe('seed_invalid_enum_value');
    expect(outcome.issues[0]?.message).toContain('"Fiction"');
  });

  it('leaves the previous rows in place when a batch is rejected', () => {
    draft.setSeedData('book', seedRows);
    draft.setSeedData('book', [{ pages: 'many' }]);

    const snapshot = draft.snapshot() as { entities: Array<{ seed?: unknown[] }> };
    expect(snapshot.entities[0]?.seed).toHaveLength(2);
  });
});

describe('components', () => {
  beforeEach(() => {
    draft.createEntity(bookEntity);
  });

  it('accepts a table with a filter', () => {
    const outcome = draft.addComponent({
      id: 'book_table',
      type: 'table',
      entityId: 'book',
      filters: [{ fieldId: 'genre', control: 'select' }],
    });
    expect(outcome).toEqual({ ok: true, issues: [] });
  });

  it('refuses a data component before any entity exists', () => {
    const empty = new ModelDraft();
    const outcome = empty.addComponent({ id: 't', type: 'table', entityId: 'book' });
    expect(outcome.issues[0]?.code).toBe('no_entities');
  });

  it('allows a text component before any entity exists', () => {
    const empty = new ModelDraft();
    expect(empty.addComponent({ id: 'intro', type: 'text', content: 'Hello.' }).ok).toBe(true);
  });

  it('reports an unknown entity reference against the component', () => {
    const outcome = draft.addComponent({ id: 't', type: 'table', entityId: 'author' });
    expect(outcome.issues[0]?.path).toBe('entityId');
    expect(outcome.issues[0]?.code).toBe('unknown_entity');
  });

  it('enforces the metric rules', () => {
    expect(
      draft.addComponent({ id: 'm', type: 'metric', entityId: 'book', aggregate: 'sum' }).issues[0]
        ?.code,
    ).toBe('metric_field_required');

    expect(
      draft.addComponent({
        id: 'm',
        type: 'metric',
        entityId: 'book',
        aggregate: 'sum',
        fieldId: 'title',
      }).issues[0]?.code,
    ).toBe('metric_field_not_numeric');

    expect(
      draft.addComponent({
        id: 'm',
        type: 'metric',
        entityId: 'book',
        aggregate: 'sum',
        fieldId: 'pages',
      }).ok,
    ).toBe(true);
  });

  it('validates a where clause against the entity', () => {
    const outcome = draft.addComponent({
      id: 'm',
      type: 'metric',
      entityId: 'book',
      aggregate: 'count',
      where: { conditions: [{ fieldId: 'finished', op: 'contains', value: 'x' }] },
    });
    expect(outcome.issues[0]?.path).toBe('where.conditions[0].op');
  });

  it('replaces a component that has the same id', () => {
    draft.addComponent({ id: 'book_table', type: 'table', entityId: 'book' });
    draft.addComponent({ id: 'book_table', type: 'table', entityId: 'book', title: 'Library' });

    expect(draft.componentIds).toEqual(['book_table']);
  });

  it('removes a component and says so when there is nothing to remove', () => {
    draft.addComponent({ id: 'book_table', type: 'table', entityId: 'book' });
    expect(draft.removeComponent('book_table').ok).toBe(true);
    expect(draft.removeComponent('book_table').issues[0]?.code).toBe('unknown_component');
  });
});

describe('layout', () => {
  it('accepts a grid and rejects an impossible column count', () => {
    expect(draft.setLayout({ type: 'grid', columns: 2 }).ok).toBe(true);
    expect(draft.setLayout({ type: 'grid', columns: 9 }).ok).toBe(false);
  });
});

describe('validation and salvage', () => {
  function buildWorkingDraft() {
    draft.setPlan('one entity, one table, one metric', 'Book tracker');
    draft.createEntity(bookEntity);
    draft.setSeedData('book', seedRows);
    draft.addComponent({ id: 'book_table', type: 'table', entityId: 'book' });
    draft.addComponent({
      id: 'total_pages',
      type: 'metric',
      entityId: 'book',
      aggregate: 'sum',
      fieldId: 'pages',
    });
    return draft;
  }

  it('validates a complete draft', () => {
    const validation = buildWorkingDraft().validate();
    expect(validation.ok).toBe(true);
    expect(validation.model?.app.name).toBe('Book tracker');
  });

  it('returns the model untouched when nothing is wrong', () => {
    const salvaged = buildWorkingDraft().salvage();
    expect(salvaged.removed).toEqual([]);
    expect(salvaged.model?.components).toHaveLength(2);
  });

  it('drops the component that broke when an entity was redefined under it', () => {
    buildWorkingDraft();
    // The seed rows never set "pages", so dropping that field breaks only the
    // metric that sums it. The table and the rows stay valid.
    draft.createEntity({
      id: 'book',
      name: 'Book',
      pluralName: 'Books',
      fields: bookEntity.fields.filter((field) => field.id !== 'pages'),
    });

    expect(draft.validate().ok).toBe(false);

    const salvaged = draft.salvage();
    expect(salvaged.removed).toEqual(['total_pages']);
    expect(salvaged.model?.components.map((c) => c.id)).toEqual(['book_table']);
    expect(salvaged.model?.entities[0]?.seed).toHaveLength(2);
  });

  it('keeps seeded rows when an entity is redefined', () => {
    buildWorkingDraft();
    draft.createEntity({ ...bookEntity, pluralName: 'Volumes' });

    const snapshot = draft.snapshot() as { entities: Array<{ seed?: unknown[] }> };
    expect(snapshot.entities[0]?.seed).toHaveLength(2);
    expect(draft.validate().ok).toBe(true);
  });

  it('drops seed data when the rows are what went wrong', () => {
    buildWorkingDraft();
    draft.createEntity({
      ...bookEntity,
      fields: [
        { id: 'title', label: 'Title', type: 'string', required: true },
        { id: 'genre', label: 'Genre', type: 'string' },
        { id: 'pages', label: 'Pages', type: 'number' },
        { id: 'finished', label: 'Finished', type: 'string' },
      ],
    });

    const salvaged = draft.salvage();
    expect(salvaged.removed).toContain('seed data');
    expect(salvaged.model).not.toBeNull();
    expect(salvaged.model?.entities[0]?.seed).toBeUndefined();
  });

  it('returns nothing when there is nothing to salvage', () => {
    expect(new ModelDraft().salvage()).toEqual({ model: null, removed: [] });
  });
});
