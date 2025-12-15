/**
 * Outcome cache.
 *
 * The eval set runs inside a free-tier quota, so rerunning a case whose inputs
 * have not changed is not merely wasteful, it is the thing most likely to make
 * the suite unrunnable on the day it matters. Every outcome is written to disk
 * under a key derived from everything that could change the answer, including
 * the prompts and the schema version, so a rerun after an unrelated edit costs
 * nothing and a rerun after a prompt edit correctly costs everything.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@nlam/shared';
import { agentSystemPrompt, baselineSystemPrompt } from '../generation/prompts.js';
import { toolDefinitions } from '../generation/tools.js';
import type { CaseOutcome, RunConfiguration } from './types.js';

/**
 * Identifies the prompts and tool definitions in force. Changing any of them
 * changes the answer, so a cached outcome from before the change must not be
 * reused, and this is what makes that automatic rather than remembered.
 */
export function promptVersion(): string {
  return createHash('sha256')
    .update(baselineSystemPrompt())
    .update(agentSystemPrompt())
    .update(JSON.stringify(toolDefinitions()))
    .digest('hex')
    .slice(0, 12);
}

export function configurationFor(
  provider: string,
  model: string,
  mode: RunConfiguration['mode'],
): RunConfiguration {
  return {
    provider,
    model,
    mode,
    promptVersion: promptVersion(),
    schemaVersion: SCHEMA_VERSION,
  };
}

export function cacheKey(
  caseId: string,
  description: string,
  configuration: RunConfiguration,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        caseId,
        description,
        provider: configuration.provider,
        model: configuration.model,
        mode: configuration.mode,
        promptVersion: configuration.promptVersion,
        schemaVersion: configuration.schemaVersion,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

export class OutcomeCache {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<CaseOutcome | undefined> {
    try {
      const raw = await readFile(join(this.directory, `${key}.json`), 'utf8');
      return JSON.parse(raw) as CaseOutcome;
    } catch {
      return undefined;
    }
  }

  async set(key: string, outcome: CaseOutcome): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      join(this.directory, `${key}.json`),
      `${JSON.stringify(outcome, null, 2)}\n`,
      'utf8',
    );
  }

  async size(): Promise<number> {
    try {
      const names = await readdir(this.directory);
      return names.filter((name) => name.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}
