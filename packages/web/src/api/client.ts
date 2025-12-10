/**
 * The browser's view of the API.
 *
 * The generation endpoint streams newline-delimited JSON rather than returning
 * one response at the end. A tool loop runs for long enough that a spinner with
 * no detail is the wrong experience, and the trace it emits is the most
 * interesting thing the system produces, so it is shown as it arrives.
 */
import type {
  ApiErrorBody,
  CatalogueEntry,
  GenerateResponse,
  GenerationEvent,
  GenerationMode,
  GenerationStep,
  HealthResponse,
} from '@nlam/shared';

export class ApiError extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return new ApiError(
      body.error?.code ?? 'request_failed',
      body.error?.message ?? `The server answered ${response.status}.`,
      body.error?.detail,
    );
  } catch {
    return new ApiError('request_failed', `The server answered ${response.status}.`);
  }
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>('/api/health');
}

export function fetchCatalogue(): Promise<{ entries: CatalogueEntry[] }> {
  return getJson<{ entries: CatalogueEntry[] }>('/api/catalogue');
}

export interface StreamOptions {
  description: string;
  mode: GenerationMode;
  accessToken?: string;
  signal?: AbortSignal;
  onStep: (step: GenerationStep) => void;
}

/**
 * Runs a generation and reports each step as it happens. Resolves with the
 * finished result, or throws an ApiError carrying the server's reason.
 */
export async function streamGeneration(options: StreamOptions): Promise<GenerateResponse> {
  const response = await fetch('/api/generate/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.accessToken ? { 'x-demo-token': options.accessToken } : {}),
    },
    body: JSON.stringify({ description: options.description, mode: options.mode }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // Failures before the stream opens (validation, auth, rate limit) come back
  // as ordinary JSON with a status code.
  if (!response.ok) throw await toApiError(response);
  if (!response.body) throw new ApiError('no_stream', 'The server did not return a stream.');

  let result: GenerateResponse | undefined;

  for await (const event of readNdjson(response.body)) {
    if (event.type === 'step') options.onStep(event.step);
    else if (event.type === 'result') result = event.result;
    else if (event.type === 'error') throw new ApiError(event.code, event.message);
  }

  if (!result) {
    throw new ApiError('incomplete_stream', 'The generation ended without returning a result.');
  }
  return result;
}

/** Splits a byte stream into JSON values, one per line, tolerating partial chunks. */
async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<GenerationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== '') yield JSON.parse(line) as GenerationEvent;
        newline = buffer.indexOf('\n');
      }
    }

    const tail = buffer.trim();
    if (tail !== '') yield JSON.parse(tail) as GenerationEvent;
  } finally {
    reader.releaseLock();
  }
}
