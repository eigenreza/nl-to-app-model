/**
 * Batch completions.
 *
 * Anthropic's batch endpoint costs half as much in exchange for asynchronous
 * turnaround. That trade only makes sense for work whose items are independent
 * of each other, which is exactly the shape of the baseline generator: every
 * fixture is its own single completion and none of them reads another's answer.
 *
 * It is deliberately not used for the agent loop. There, turn two cannot be
 * written until turn one's tool results come back, so batching would either
 * serialise into one-item batches (no saving, much worse latency) or change
 * what the loop does, and the loop is the thing being measured.
 */
import Anthropic from '@anthropic-ai/sdk';
import { type TokenUsage } from '@nlam/shared';
import { buildRequest, readUsage, toProviderError } from './anthropic.js';
import type { CompletionRequest, CompletionResponse } from './types.js';

export interface BatchItem {
  /** Caller's identifier, returned alongside the answer. */
  id: string;
  request: CompletionRequest;
}

export type BatchOutcome =
  | { id: string; ok: true; response: CompletionResponse }
  | { id: string; ok: false; error: Error };

export interface BatchRunnerOptions {
  apiKey: string;
  model: string;
  promptCaching?: boolean;
  /** Give up waiting after this long and report the unfinished items. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  onProgress?: (info: { status: string; waitedMs: number }) => void;
  /** Injected by tests. */
  client?: Anthropic;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Custom ids must survive a round trip through the API, which restricts them to
 * a conservative character set. Case ids are already slugs, but the mapping is
 * kept explicit rather than assumed.
 */
function toCustomId(index: number): string {
  return `item_${index}`;
}

export class BatchRunner {
  private readonly client: Anthropic;

  constructor(private readonly options: BatchRunnerOptions) {
    this.client =
      options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
  }

  /**
   * Submits every item as one batch and waits for the whole batch to end.
   * Returns one outcome per item, in the order they were given, so a caller can
   * zip them straight back onto its own list.
   */
  async run(items: readonly BatchItem[]): Promise<BatchOutcome[]> {
    if (items.length === 0) return [];

    const sleep = this.options.sleep ?? defaultSleep;
    const now = this.options.now ?? (() => Date.now());
    const maxWaitMs = this.options.maxWaitMs ?? 30 * 60_000;
    const pollIntervalMs = this.options.pollIntervalMs ?? 5_000;

    let batch;
    try {
      batch = await this.client.messages.batches.create({
        requests: items.map((item, index) => ({
          custom_id: toCustomId(index),
          params: buildRequest(this.options.model, item.request, this.options.promptCaching ?? false),
        })),
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const startedAt = now();

    while (batch.processing_status !== 'ended') {
      const waited = now() - startedAt;
      if (waited > maxWaitMs) {
        throw new Error(
          `Batch ${batch.id} was still ${batch.processing_status} after ${Math.round(waited / 1000)}s. ` +
            'It will finish on the provider side; rerun once it has, or fall back to sequential calls.',
        );
      }

      this.options.onProgress?.({ status: batch.processing_status, waitedMs: waited });
      await sleep(pollIntervalMs);

      try {
        batch = await this.client.messages.batches.retrieve(batch.id);
      } catch (error) {
        throw toProviderError(error);
      }
    }

    const byCustomId = new Map<string, BatchOutcome>();

    const results = await this.client.messages.batches.results(batch.id);
    for await (const entry of results) {
      const index = Number(entry.custom_id.replace('item_', ''));
      const item = items[index];
      if (!item) continue;

      if (entry.result.type === 'succeeded') {
        byCustomId.set(entry.custom_id, {
          id: item.id,
          ok: true,
          response: toCompletionResponse(entry.result.message),
        });
      } else {
        const detail =
          entry.result.type === 'errored'
            ? JSON.stringify(entry.result.error)
            : entry.result.type;
        byCustomId.set(entry.custom_id, {
          id: item.id,
          ok: false,
          error: new Error(`Batch item ${entry.custom_id} ${entry.result.type}: ${detail}`),
        });
      }
    }

    return items.map((item, index) => {
      const found = byCustomId.get(toCustomId(index));
      return (
        found ?? {
          id: item.id,
          ok: false as const,
          error: new Error(`Batch returned no result for ${toCustomId(index)}.`),
        }
      );
    });
  }
}

/** Batch results carry the same message shape as a synchronous call. */
export function toCompletionResponse(message: Anthropic.Message): CompletionResponse {
  let text = '';
  const toolCalls: CompletionResponse['toolCalls'] = [];

  for (const block of message.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return {
    text,
    toolCalls,
    usage: readUsage(message.usage) satisfies TokenUsage,
    finishReason: (message.stop_reason ?? 'unknown').toLowerCase(),
    // A batch item has no meaningful per-call latency: it reports the wait for
    // the whole batch, not the model's time on this item.
    latencyMs: 0,
  };
}
