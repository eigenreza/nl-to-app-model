/**
 * The generation trace types are part of the contract with the browser, so
 * they are defined in the shared package. This module re-exports them so that
 * server code can import them from where it uses them.
 */
export type {
  FailureReason,
  FailureReport,
  GenerationMode,
  GenerationResult,
  GenerationStep,
  StepKind,
} from '@nlam/shared';
