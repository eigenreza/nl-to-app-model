import { describe, expect, it } from 'vitest';
import { EXAMPLE_MODELS } from '@nlam/shared';
import { createAppStore } from './index.js';
import { jsonTextApplied, modelApplied, serialiseModel } from './actions.js';
import { rowRemoved } from './runtimeSlice.js';

function storeWith(model = EXAMPLE_MODELS.book_tracker) {
  const store = createAppStore();
  store.dispatch(modelApplied(model, 'example', 'book_tracker'));
  return store;
}

describe('model state', () => {
  it('starts on a reference model with no issues', () => {
    const state = createAppStore().getState();
    expect(state.model.model?.app.name).toBe('Book tracker');
    expect(state.model.issues).toEqual([]);
    expect(state.runtime.data.book).toHaveLength(5);
  });

  it('keeps the last valid model when the text stops being valid json', () => {
    const store = storeWith();
    store.dispatch(jsonTextApplied('{ not json'));

    const state = store.getState();
    expect(state.model.jsonText).toBe('{ not json');
    expect(state.model.model?.app.name).toBe('Book tracker');
    expect(state.model.issues[0]?.code).toBe('invalid_json');
  });

  it('keeps the last valid model when the document breaks a schema rule', () => {
    const store = storeWith();
    const broken = { ...EXAMPLE_MODELS.book_tracker, entities: [] };
    store.dispatch(jsonTextApplied(JSON.stringify(broken)));

    expect(store.getState().model.model?.entities).toHaveLength(1);
    expect(store.getState().model.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('adopts a valid edit and marks the source as edited', () => {
    const store = storeWith();
    const renamed = {
      ...EXAMPLE_MODELS.book_tracker,
      app: { ...EXAMPLE_MODELS.book_tracker.app, name: 'Reading log' },
    };
    store.dispatch(jsonTextApplied(serialiseModel(renamed)));

    expect(store.getState().model.model?.app.name).toBe('Reading log');
    expect(store.getState().model.source).toBe('edited');
    expect(store.getState().model.exampleId).toBeNull();
  });
});

describe('runtime state', () => {
  it('keeps rows across an edit that does not touch the data model', () => {
    const store = storeWith();
    const firstRowId = store.getState().runtime.data.book?.[0]?.id;
    store.dispatch(rowRemoved({ entityId: 'book', rowId: firstRowId! }));
    expect(store.getState().runtime.data.book).toHaveLength(4);

    const renamed = {
      ...EXAMPLE_MODELS.book_tracker,
      app: { ...EXAMPLE_MODELS.book_tracker.app, name: 'Reading log' },
    };
    store.dispatch(jsonTextApplied(serialiseModel(renamed)));

    expect(store.getState().runtime.data.book).toHaveLength(4);
  });

  it('rebuilds rows when the entity definition changes', () => {
    const store = storeWith();
    store.dispatch(rowRemoved({ entityId: 'book', rowId: store.getState().runtime.data.book![0]!.id }));

    const withExtraSeed = structuredClone(EXAMPLE_MODELS.book_tracker);
    withExtraSeed.entities[0]!.seed!.push({ title: 'Solaris', finished: false });
    store.dispatch(jsonTextApplied(serialiseModel(withExtraSeed)));

    expect(store.getState().runtime.data.book).toHaveLength(6);
  });

  it('rebuilds rows when a different reference model is loaded', () => {
    const store = storeWith();
    store.dispatch(modelApplied(EXAMPLE_MODELS.contact_list, 'example', 'contact_list'));

    const state = store.getState();
    expect(state.runtime.data.contact).toHaveLength(3);
    expect(state.runtime.data.book).toBeUndefined();
    expect(state.model.exampleId).toBe('contact_list');
  });
});
