import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  DEFAULT_EXAMPLE_ID,
  EXAMPLE_MODELS,
  createInitialData,
  type ApplicationModel,
  type EntityData,
  type RuntimeRow,
} from '@nlam/shared';
import { jsonTextApplied, modelApplied } from './actions.js';

export interface RuntimeState {
  /**
   * Fingerprint of the entity definitions the current rows were built from.
   * Editing a title or a layout leaves this unchanged, so rows the user added
   * survive edits that do not touch the data model. Changing a field or a seed
   * row does change it, and the dataset is rebuilt.
   */
  signature: string;
  data: EntityData;
  /** Interactive filter values, keyed by table component id then field id. */
  tableFilters: Record<string, Record<string, string>>;
  /** Raw text held by form inputs, keyed by form component id then field id. */
  formDrafts: Record<string, Record<string, string>>;
  /** Per-field messages shown after a failed submit. */
  formErrors: Record<string, Record<string, string>>;
  /** Short confirmation shown after a successful submit. */
  notice: string | null;
}

function signatureOf(model: ApplicationModel): string {
  return JSON.stringify(model.entities);
}

function freshState(model: ApplicationModel): RuntimeState {
  return {
    signature: signatureOf(model),
    data: createInitialData(model),
    tableFilters: {},
    formDrafts: {},
    formErrors: {},
    notice: null,
  };
}

const initialState: RuntimeState = freshState(EXAMPLE_MODELS[DEFAULT_EXAMPLE_ID]);

const runtimeSlice = createSlice({
  name: 'runtime',
  initialState,
  reducers: {
    tableFilterChanged(
      state,
      action: PayloadAction<{ componentId: string; fieldId: string; value: string }>,
    ) {
      const { componentId, fieldId, value } = action.payload;
      const current = state.tableFilters[componentId] ?? {};
      current[fieldId] = value;
      state.tableFilters[componentId] = current;
    },

    tableFiltersCleared(state, action: PayloadAction<{ componentId: string }>) {
      delete state.tableFilters[action.payload.componentId];
    },

    formFieldChanged(
      state,
      action: PayloadAction<{ componentId: string; fieldId: string; value: string }>,
    ) {
      const { componentId, fieldId, value } = action.payload;
      const draft = state.formDrafts[componentId] ?? {};
      draft[fieldId] = value;
      state.formDrafts[componentId] = draft;

      const errors = state.formErrors[componentId];
      if (errors && errors[fieldId]) {
        delete errors[fieldId];
      }
      state.notice = null;
    },

    formErrorsReported(
      state,
      action: PayloadAction<{ componentId: string; errors: Record<string, string> }>,
    ) {
      state.formErrors[action.payload.componentId] = action.payload.errors;
      state.notice = null;
    },

    rowAdded(
      state,
      action: PayloadAction<{
        componentId: string;
        entityId: string;
        row: RuntimeRow;
        notice: string;
      }>,
    ) {
      const { componentId, entityId, row, notice } = action.payload;
      const rows = state.data[entityId];
      if (!rows) return;
      rows.push(row);
      delete state.formDrafts[componentId];
      delete state.formErrors[componentId];
      state.notice = notice;
    },

    rowRemoved(state, action: PayloadAction<{ entityId: string; rowId: string }>) {
      const rows = state.data[action.payload.entityId];
      if (!rows) return;
      state.data[action.payload.entityId] = rows.filter((row) => row.id !== action.payload.rowId);
      state.notice = null;
    },

    noticeDismissed(state) {
      state.notice = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(jsonTextApplied, (state, action) => {
        const model = action.payload.model;
        if (!model) return state;
        // Only rebuild when the data model itself moved. Cosmetic edits keep
        // whatever the user has entered so far.
        return signatureOf(model) === state.signature ? state : freshState(model);
      })
      .addCase(modelApplied, (_state, action) => freshState(action.payload.model));
  },
});

export const {
  tableFilterChanged,
  tableFiltersCleared,
  formFieldChanged,
  formErrorsReported,
  rowAdded,
  rowRemoved,
  noticeDismissed,
} = runtimeSlice.actions;

export const runtimeReducer = runtimeSlice.reducer;
