import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  CatalogueEntry,
  FailureReport,
  GenerateResponse,
  GenerationMode,
  GenerationStep,
  HealthResponse,
  TokenUsage,
} from '@nlam/shared';
import { ApiError, fetchCatalogue, fetchHealth, streamGeneration } from '../api/client.js';
import { modelApplied } from './actions.js';

export type GenerationStatus = 'idle' | 'running' | 'succeeded' | 'failed';

export interface GenerationSummary {
  iterations: number;
  latencyMs: number;
  usage: TokenUsage;
  estimatedCostUsd: number | null;
  validFirstTry: boolean;
  source: 'live' | 'replay';
  provider: string;
  model: string;
}

export interface GenerationState {
  status: GenerationStatus;
  description: string;
  mode: GenerationMode;
  accessToken: string;
  /** Steps as they arrive, so the trace is visible while the loop is running. */
  steps: GenerationStep[];
  summary: GenerationSummary | null;
  /** The generator's own report of what it could not do. */
  failure: FailureReport | null;
  /** A transport or policy failure, which is a different thing entirely. */
  error: { code: string; message: string } | null;
  health: HealthResponse | null;
  catalogue: CatalogueEntry[];
}

const initialState: GenerationState = {
  status: 'idle',
  description: '',
  mode: 'agent',
  accessToken: '',
  steps: [],
  summary: null,
  failure: null,
  error: null,
  health: null,
  catalogue: [],
};

/** Loads what this deployment can do, so the browser can say so up front. */
export const loadDeploymentInfo = createAsyncThunk('generation/loadInfo', async () => {
  const [health, catalogue] = await Promise.all([fetchHealth(), fetchCatalogue()]);
  return { health, entries: catalogue.entries };
});

/**
 * Runs a generation. Steps are dispatched as they arrive rather than collected,
 * and a successful result is applied to the model slice, which is what makes
 * the rendered application appear.
 */
export const generate = createAsyncThunk<
  GenerateResponse,
  void,
  { state: { generation: GenerationState }; rejectValue: { code: string; message: string } }
>('generation/generate', async (_arg, thunkApi) => {
  const { description, mode, accessToken } = thunkApi.getState().generation;

  try {
    const result = await streamGeneration({
      description,
      mode,
      ...(accessToken ? { accessToken } : {}),
      signal: thunkApi.signal,
      onStep: (step) => thunkApi.dispatch(stepReceived(step)),
    });

    // A failed generation can still carry a partial model worth rendering.
    if (result.applicationModel) {
      thunkApi.dispatch(modelApplied(result.applicationModel, 'generated'));
    }

    return result;
  } catch (error) {
    if (error instanceof ApiError) {
      return thunkApi.rejectWithValue({ code: error.code, message: error.message });
    }
    return thunkApi.rejectWithValue({
      code: 'network_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const generationSlice = createSlice({
  name: 'generation',
  initialState,
  reducers: {
    descriptionChanged(state, action: PayloadAction<string>) {
      state.description = action.payload;
    },
    modeChanged(state, action: PayloadAction<GenerationMode>) {
      state.mode = action.payload;
    },
    accessTokenChanged(state, action: PayloadAction<string>) {
      state.accessToken = action.payload;
    },
    stepReceived(state, action: PayloadAction<GenerationStep>) {
      state.steps.push(action.payload);
    },
    traceCleared(state) {
      state.steps = [];
      state.summary = null;
      state.failure = null;
      state.error = null;
      state.status = 'idle';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadDeploymentInfo.fulfilled, (state, action) => {
        state.health = action.payload.health;
        state.catalogue = action.payload.entries;
      })
      .addCase(generate.pending, (state) => {
        state.status = 'running';
        state.steps = [];
        state.summary = null;
        state.failure = null;
        state.error = null;
      })
      .addCase(generate.fulfilled, (state, action) => {
        const result = action.payload;
        state.status = result.ok ? 'succeeded' : 'failed';
        state.failure = result.failure;
        state.summary = {
          iterations: result.iterations,
          latencyMs: result.latencyMs,
          usage: result.usage,
          estimatedCostUsd: result.estimatedCostUsd,
          validFirstTry: result.validFirstTry,
          source: result.source,
          provider: result.provider,
          model: result.model,
        };
      })
      .addCase(generate.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload ?? {
          code: 'unknown_error',
          message: 'The generation could not be started.',
        };
      });
  },
});

export const { descriptionChanged, modeChanged, accessTokenChanged, stepReceived, traceCleared } =
  generationSlice.actions;

export const generationReducer = generationSlice.reducer;
