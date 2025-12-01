import { createAction } from '@reduxjs/toolkit';
import {
  validateApplicationModelJson,
  type ApplicationModel,
  type ExampleId,
  type ValidationIssue,
} from '@nlam/shared';

/** Where the model currently on screen came from. Shown in the editor header. */
export type ModelSource = 'example' | 'generated' | 'edited';

export function serialiseModel(model: ApplicationModel): string {
  return JSON.stringify(model, null, 2);
}

/**
 * Two actions carry every model change in the application, and both slices
 * listen to them. Validation happens once, in the prepare callback, so the
 * editor and the renderer can never disagree about whether the document on
 * screen is valid.
 */
export const jsonTextApplied = createAction('model/jsonTextApplied', (text: string) => {
  const validation = validateApplicationModelJson(text);
  return {
    payload: {
      text,
      model: validation.model,
      issues: validation.issues satisfies ValidationIssue[],
    },
  };
});

export const modelApplied = createAction(
  'model/modelApplied',
  (model: ApplicationModel, source: ModelSource, exampleId: ExampleId | null = null) => ({
    payload: { model, source, exampleId, text: serialiseModel(model) },
  }),
);
