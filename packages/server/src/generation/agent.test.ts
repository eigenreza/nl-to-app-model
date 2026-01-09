import { describe, expect, it } from 'vitest';
import { ScriptedProvider, textTurn, toolTurn, type ScriptedTurn } from '../providers/scripted.js';
import { ProviderError, type CompletionResponse } from '../providers/types.js';
import { generateWithAgent } from './agent.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const BOOK_ENTITY = {
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

const SEED_ROWS = [
  { title: 'Piranesi', genre: 'Fiction', pages: 245, finished: false },
  { title: 'The Making of the Atomic Bomb', genre: 'History', pages: 886, finished: true },
  { title: 'Thinking in Systems', genre: 'History', pages: 240, finished: true },
];

/** One turn that calls several tools, as providers frequently do. */
function multiToolTurn(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): Partial<CompletionResponse> {
  return {
    text: '',
    toolCalls: calls.map((call, index) => ({
      id: `call_${index}`,
      name: call.name,
      arguments: call.args,
    })),
    usage: { inputTokens: 200, outputTokens: 80 },
  };
}

const PLAN = toolTurn('plan', {
  summary: 'One book entity, a table with a genre filter, and a count of unfinished books.',
  appName: 'Book tracker',
});
const CREATE = toolTurn('create_entity', BOOK_ENTITY);
const SEED = toolTurn('set_seed_data', { entityId: 'book', rowsJson: JSON.stringify(SEED_ROWS) });
const TABLE = toolTurn('add_component', {
  id: 'book_table',
  type: 'table',
  entityId: 'book',
  filters: [{ fieldId: 'genre', control: 'select' }],
});
const METRIC = toolTurn('add_component', {
  id: 'unread',
  type: 'metric',
  entityId: 'book',
  aggregate: 'count',
  whereJson: JSON.stringify({ conditions: [{ fieldId: 'finished', op: 'isFalse' }] }),
});
const VALIDATE = toolTurn('validate_model', {});
const FINALIZE = toolTurn('finalize', {});

function run(turns: ScriptedTurn[], overrides: { maxIterations?: number } = {}) {
  const provider = new ScriptedProvider(turns, { fallback: { text: 'nothing left to say' } });
  return generateWithAgent({
    description: 'a book tracker with a genre filter and a count of unread books',
    provider,
    maxIterations: overrides.maxIterations ?? 8,
  }).then((result) => ({ result, provider }));
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('generateWithAgent', () => {
  it('builds a model through the tool sequence', async () => {
    const { result } = await run([PLAN, CREATE, SEED, TABLE, METRIC, VALIDATE, FINALIZE]);

    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.mode).toBe('agent');
    expect(result.iterations).toBe(7);
    expect(result.applicationModel?.app.name).toBe('Book tracker');
    expect(result.applicationModel?.entities[0]?.seed).toHaveLength(3);
    expect(result.applicationModel?.components.map((c) => c.id)).toEqual(['book_table', 'unread']);
  });

  it('marks a run with no rejected tool call as valid first try', async () => {
    const { result } = await run([PLAN, CREATE, SEED, TABLE, VALIDATE, FINALIZE]);
    expect(result.validFirstTry).toBe(true);
  });

  it('offers every tool on the first call', async () => {
    const { provider } = await run([PLAN, CREATE, SEED, TABLE, FINALIZE]);
    const names = provider.requests[0]?.tools?.map((tool) => tool.name);

    expect(names).toEqual([
      'plan',
      'create_entity',
      'set_seed_data',
      'add_component',
      'remove_component',
      'set_layout',
      'validate_model',
      'finalize',
    ]);
  });

  it('handles several tool calls in one turn', async () => {
    const { result } = await run([
      multiToolTurn([
        { name: 'plan', args: { summary: 'one entity', appName: 'Book tracker' } },
        { name: 'create_entity', args: BOOK_ENTITY },
      ]),
      multiToolTurn([
        { name: 'add_component', args: { id: 'book_table', type: 'table', entityId: 'book' } },
        { name: 'finalize', args: {} },
      ]),
    ]);

    expect(result.ok).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.steps).toHaveLength(4);
  });

  it('charges token usage to the turn rather than to each call in it', async () => {
    const { result } = await run([
      multiToolTurn([
        { name: 'plan', args: { summary: 'one entity', appName: 'Book tracker' } },
        { name: 'create_entity', args: BOOK_ENTITY },
      ]),
      multiToolTurn([
        { name: 'add_component', args: { id: 'book_table', type: 'table', entityId: 'book' } },
        { name: 'finalize', args: {} },
      ]),
    ]);

    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 160 });
    expect(result.steps.map((step) => step.usage.outputTokens)).toEqual([80, 0, 80, 0]);
  });

  it('feeds a rejection back and accepts the correction', async () => {
    const brokenMetric = toolTurn('add_component', {
      id: 'unread',
      type: 'metric',
      entityId: 'book',
      aggregate: 'sum',
      fieldId: 'title',
    });

    const { result, provider } = await run([PLAN, CREATE, TABLE, brokenMetric, METRIC, FINALIZE]);

    expect(result.ok).toBe(true);
    expect(result.validFirstTry).toBe(false);

    const rejection = result.steps.find((step) => !step.ok);
    expect(rejection?.label).toContain('rejected');
    expect(rejection?.issues?.[0]?.code).toBe('metric_field_not_numeric');

    // The rejection reached the provider as a tool result, not as a crash.
    const followUp = provider.requests[4]!.messages.at(-1)!;
    expect(followUp.role).toBe('tool');
    expect(followUp.role === 'tool' && followUp.content).toContain(
      'needs a field of type "number"',
    );
  });

  it('refuses to finalize while the model is invalid and says why', async () => {
    const { result, provider } = await run([
      PLAN,
      CREATE,
      FINALIZE, // No components yet.
      TABLE,
      FINALIZE,
    ]);

    expect(result.ok).toBe(true);
    const refusal = result.steps.find((step) => step.kind === 'finalize' && !step.ok);
    expect(refusal?.label).toContain('Refused to finalize');

    const toolResult = provider.requests[3]!.messages.at(-1)!;
    expect(toolResult.role === 'tool' && toolResult.content).toContain('Cannot finalize');
  });

  it('stops at the iteration cap and returns the best partial model', async () => {
    const brokenComponent = toolTurn('add_component', {
      id: 'broken',
      type: 'metric',
      entityId: 'book',
      aggregate: 'sum',
      fieldId: 'nope',
    });

    const { result } = await run([PLAN, CREATE, SEED, TABLE, brokenComponent, brokenComponent], {
      maxIterations: 6,
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('iteration_cap');
    expect(result.failure?.message).toContain('maximum of 6 iterations');
    // The table survived even though the run failed.
    expect(result.applicationModel?.components.map((c) => c.id)).toEqual(['book_table']);
  });

  it('reports outstanding issues alongside the partial model', async () => {
    const { result } = await run([PLAN, CREATE, TABLE], { maxIterations: 3 });

    expect(result.ok).toBe(false);
    expect(result.applicationModel).not.toBeNull();
    expect(result.failure?.message).toContain('Returning the model as it stood');
  });

  it('returns nothing to render when no tool ever succeeded', async () => {
    const { result } = await run([textTurn('I would rather not.')], { maxIterations: 1 });

    expect(result.ok).toBe(false);
    expect(result.applicationModel).toBeNull();
    expect(result.failure?.message).toContain('Nothing valid could be salvaged');
  });

  it('nudges a provider that stops calling tools, then gives up', async () => {
    const { result, provider } = await run([
      PLAN,
      textTurn('Let me think about this.'),
      textTurn('Still thinking.'),
      textTurn('Done thinking.'),
    ]);

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('invalid_model');
    expect(result.failure?.message).toContain('stopped calling tools');

    const nudge = provider.requests[2]!.messages.at(-1)!;
    expect(nudge.role === 'user' && nudge.content).toContain('Continue by calling tools');
  });

  it('surfaces a provider failure and keeps whatever was built', async () => {
    const { result } = await run([
      PLAN,
      CREATE,
      TABLE,
      new ProviderError('Quota exhausted', { provider: 'scripted', status: 429 }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('provider_error');
    expect(result.failure?.message).toContain('Quota exhausted');
    expect(result.applicationModel?.components).toHaveLength(1);
  });

  it('stops when the provider time budget is spent', async () => {
    // Each turn reports 600ms of provider time, so the third check trips a
    // budget of one second. Wall clock is not what is being measured: the rate
    // limiter's deliberate spacing must not count against the model.
    const slow = (turn: Partial<CompletionResponse>) => ({ ...turn, latencyMs: 600 });
    const provider = new ScriptedProvider([slow(PLAN), slow(CREATE), slow(TABLE), slow(FINALIZE)]);

    const result = await generateWithAgent({
      description: 'a book tracker',
      provider,
      timeBudgetMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('time_budget');
    expect(result.failure?.message).toContain('provider time');
    expect(result.iterations).toBe(2);
    expect(result.steps.at(-1)?.label).toBe('Stopped: out of time.');
  });

  it('does not count time spent waiting on the rate limiter', async () => {
    // Turns report no provider time at all, so however long the wall clock
    // says the run took, the budget is untouched.
    const provider = new ScriptedProvider([PLAN, CREATE, TABLE, FINALIZE]);

    const result = await generateWithAgent({
      description: 'a book tracker',
      provider,
      timeBudgetMs: 1,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects an unknown tool without ending the run', async () => {
    const { result, provider } = await run([
      PLAN,
      toolTurn('add_chart', { id: 'c' }),
      CREATE,
      TABLE,
      FINALIZE,
    ]);

    expect(result.ok).toBe(true);
    const unknown = result.steps.find((step) => step.label.includes('Unknown tool'));
    expect(unknown?.ok).toBe(false);

    const toolResult = provider.requests[2]!.messages.at(-1)!;
    expect(toolResult.role === 'tool' && toolResult.content).toContain('Available tools are');
  });

  it('reports a where clause that is not valid json against the component', async () => {
    const badWhere = toolTurn('add_component', {
      id: 'unread',
      type: 'metric',
      entityId: 'book',
      aggregate: 'count',
      whereJson: '{conditions: [',
    });

    const { result } = await run([PLAN, CREATE, badWhere, METRIC, TABLE, FINALIZE]);

    expect(result.ok).toBe(true);
    const rejection = result.steps.find((step) => !step.ok);
    expect(rejection?.issues?.[0]?.message).toContain('whereJson is not valid JSON');
  });

  it('records a readable trace of what happened', async () => {
    const { result } = await run([PLAN, CREATE, SEED, TABLE, METRIC, VALIDATE, FINALIZE]);

    expect(result.steps.map((step) => step.label)).toEqual([
      'Planned the application.',
      'Created entity "book" with 4 fields.',
      'Seeded "book" with 3 rows.',
      'Added table "book_table".',
      'Added metric "unread".',
      'Validated the draft: no errors.',
      'Accepted the model.',
    ]);
    expect(result.steps.map((step) => step.kind)).toEqual([
      'plan',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'finalize',
    ]);
  });
});
