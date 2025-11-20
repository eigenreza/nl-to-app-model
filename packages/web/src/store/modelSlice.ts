import { createSlice } from '@reduxjs/toolkit';
import {
  DEFAULT_EXAMPLE_ID,
  EXAMPLE_MODELS,
  type ApplicationModel,
  type ExampleId,
  type ValidationIssue,
} from '@nlam/shared';
import { jsonTextApplied, modelApplied, serialiseModel, type ModelSource } from './actions.js';

export interface ModelState {
  /** Exactly what is in the editor, valid or not. */
  jsonText: string;
  /**
   * The last document that validated. Kept when an edit breaks the JSON so the
   * rendered application stays on screen while the user fixes the text, which
   * is the whole point of showing them side by side.
   */
  model: ApplicationModel | null;
  issues: ValidationIssue[];
  source: ModelSource;
  exampleId: ExampleId | null;
}

const initialModel = EXAMPLE_MODELS[DEFAULT_EXAMPLE_ID];

const initialState: ModelState = {
  jsonText: serialiseModel(initialModel),
  model: initialModel,
  issues: [],
  source: 'example',
  exampleId: DEFAULT_EXAMPLE_ID,
};

const modelSlice = createSlice({
  name: 'model',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(jsonTextApplied, (state, action) => {
        state.jsonText = action.payload.text;
        state.issues = action.payload.issues;
        if (action.payload.model) {
          state.model = action.payload.model;
          state.source = 'edited';
          state.exampleId = null;
        }
      })
      .addCase(modelApplied, (state, action) => {
        state.jsonText = action.payload.text;
        state.model = action.payload.model;
        state.issues = [];
        state.source = action.payload.source;
        state.exampleId = action.payload.exampleId;
      });
  },
});

export const modelReducer = modelSlice.reducer;
