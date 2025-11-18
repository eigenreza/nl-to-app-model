import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_MODELS } from './examples.js';
import type { Entity, MetricComponent, TableComponent } from './model.js';
import {
  applyFilterExpression,
  computeMetric,
  createInitialData,
  evaluateCondition,
  filterOptions,
  formatCellValue,
  formatNumber,
  normaliseRow,
  resetRowIds,
  selectTableRows,
  tableColumns,
  type RuntimeRow,
} from './runtime.js';

const book = EXAMPLE_MODELS.book_tracker.entities[0] as Entity;

function rowsFor(entityId: string, modelId: keyof typeof EXAMPLE_MODELS = 'book_tracker') {
  return createInitialData(EXAMPLE_MODELS[modelId])[entityId] as RuntimeRow[];
}

function row(values: Record<string, unknown>): RuntimeRow {
  return normaliseRow(book, values as never);
}

beforeEach(() => {
  resetRowIds();
});

describe('data setup', () => {
  it('seeds one row per seed entry and fills in missing fields', () => {
    const rows = rowsFor('book');
    expect(rows).toHaveLength(5);
    expect(Object.keys(rows[0]!.values).sort()).toEqual(book.fields.map((f) => f.id).sort());
  });

  it('gives booleans false and everything else null when unset', () => {
    const created = row({ title: 'Untitled' });
    expect(created.values.finished).toBe(false);
    expect(created.values.pages).toBeNull();
    expect(created.values.genre).toBeNull();
  });

  it('assigns unique ids prefixed with the entity id', () => {
    const a = row({ title: 'a' });
    const b = row({ title: 'b' });
    expect(a.id).toBe('book_1');
    expect(b.id).toBe('book_2');
  });
});

describe('condition evaluation', () => {
  const sample = () => row({ title: 'Piranesi', pages: 245, finished: false, genre: 'Fiction' });

  it('handles equality and inequality', () => {
    expect(evaluateCondition({ fieldId: 'genre', op: 'equals', value: 'Fiction' }, sample())).toBe(
      true,
    );
    expect(
      evaluateCondition({ fieldId: 'genre', op: 'notEquals', value: 'Fiction' }, sample()),
    ).toBe(false);
  });

  it('handles the unary operators', () => {
    expect(evaluateCondition({ fieldId: 'finished', op: 'isFalse' }, sample())).toBe(true);
    expect(evaluateCondition({ fieldId: 'finished', op: 'isTrue' }, sample())).toBe(false);
    expect(evaluateCondition({ fieldId: 'author', op: 'isEmpty' }, sample())).toBe(true);
    expect(evaluateCondition({ fieldId: 'title', op: 'isNotEmpty' }, sample())).toBe(true);
  });

  it('compares numbers numerically', () => {
    expect(evaluateCondition({ fieldId: 'pages', op: 'greaterThan', value: 200 }, sample())).toBe(
      true,
    );
    expect(
      evaluateCondition({ fieldId: 'pages', op: 'lessThanOrEqual', value: 245 }, sample()),
    ).toBe(true);
    expect(evaluateCondition({ fieldId: 'pages', op: 'greaterThan', value: 900 }, sample())).toBe(
      false,
    );
  });

  it('compares dates as ordered iso strings', () => {
    const dated = row({ title: 'x', added_on: '2024-03-19' });
    expect(
      evaluateCondition({ fieldId: 'added_on', op: 'greaterThan', value: '2024-01-01' }, dated),
    ).toBe(true);
    expect(
      evaluateCondition({ fieldId: 'added_on', op: 'lessThan', value: '2024-01-01' }, dated),
    ).toBe(false);
  });

  it('matches contains case insensitively', () => {
    expect(evaluateCondition({ fieldId: 'title', op: 'contains', value: 'ranes' }, sample())).toBe(
      true,
    );
    expect(evaluateCondition({ fieldId: 'title', op: 'contains', value: 'PIRA' }, sample())).toBe(
      true,
    );
    expect(evaluateCondition({ fieldId: 'title', op: 'contains', value: 'zzz' }, sample())).toBe(
      false,
    );
  });

  it('treats an unset value as not matching an ordered comparison', () => {
    const empty = row({ title: 'x' });
    expect(evaluateCondition({ fieldId: 'pages', op: 'greaterThan', value: 0 }, empty)).toBe(false);
  });
});

describe('filter expressions', () => {
  const rows = () => [
    row({ title: 'a', genre: 'Fiction', finished: true, pages: 100 }),
    row({ title: 'b', genre: 'History', finished: false, pages: 900 }),
    row({ title: 'c', genre: 'Fiction', finished: false, pages: 300 }),
  ];

  it('joins with and by default', () => {
    const selected = applyFilterExpression(
      {
        combinator: 'and',
        conditions: [
          { fieldId: 'genre', op: 'equals', value: 'Fiction' },
          { fieldId: 'finished', op: 'isFalse' },
        ],
      },
      rows(),
    );
    expect(selected.map((r) => r.values.title)).toEqual(['c']);
  });

  it('joins with or', () => {
    const selected = applyFilterExpression(
      {
        combinator: 'or',
        conditions: [
          { fieldId: 'genre', op: 'equals', value: 'History' },
          { fieldId: 'pages', op: 'lessThan', value: 200 },
        ],
      },
      rows(),
    );
    expect(selected.map((r) => r.values.title)).toEqual(['a', 'b']);
  });

  it('returns everything when there is no expression', () => {
    expect(applyFilterExpression(undefined, rows())).toHaveLength(3);
  });
});

describe('table selection', () => {
  const table = EXAMPLE_MODELS.book_tracker.components.find(
    (c): c is TableComponent => c.id === 'book_table',
  )!;

  it('shows every seeded row when no control is set', () => {
    expect(selectTableRows(table, book, rowsFor('book'), {})).toHaveLength(5);
  });

  it('narrows by a select control', () => {
    const selected = selectTableRows(table, book, rowsFor('book'), { genre: 'Fiction' });
    expect(selected).toHaveLength(2);
  });

  it('narrows by a text control, case insensitively', () => {
    const selected = selectTableRows(table, book, rowsFor('book'), { title: 'piranesi' });
    expect(selected.map((r) => r.values.title)).toEqual(['Piranesi']);
  });

  it('combines the fixed filter with the interactive one', () => {
    const scoped: TableComponent = {
      ...table,
      where: { combinator: 'and', conditions: [{ fieldId: 'finished', op: 'isFalse' }] },
    };
    const selected = selectTableRows(scoped, book, rowsFor('book'), { genre: 'Fiction' });
    expect(selected.map((r) => r.values.title)).toEqual(['Piranesi']);
  });

  it('offers a neutral option first for select filters', () => {
    const genre = book.fields.find((f) => f.id === 'genre')!;
    const options = filterOptions(genre);
    expect(options[0]?.value).toBe('');
    expect(options.map((o) => o.value)).toContain('History');

    const finished = book.fields.find((f) => f.id === 'finished')!;
    expect(filterOptions(finished).map((o) => o.value)).toEqual(['', 'true', 'false']);
  });

  it('honours an explicit column list and ignores unknown ids', () => {
    expect(tableColumns(table, book).map((f) => f.id)).toEqual([
      'title',
      'author',
      'genre',
      'pages',
      'finished',
    ]);
    expect(tableColumns({ ...table, columns: undefined }, book)).toHaveLength(6);
  });
});

describe('metrics', () => {
  const metricNamed = (id: string, modelId: keyof typeof EXAMPLE_MODELS) =>
    EXAMPLE_MODELS[modelId].components.find((c): c is MetricComponent => c.id === id)!;

  it('counts rows', () => {
    expect(computeMetric(metricNamed('total_books', 'book_tracker'), rowsFor('book')).value).toBe(
      5,
    );
  });

  it('counts rows that pass a filter', () => {
    const result = computeMetric(metricNamed('unread_books', 'book_tracker'), rowsFor('book'));
    expect(result.value).toBe(3);
    expect(result.formatted).toBe('3');
  });

  it('sums and averages a numeric field', () => {
    const rows = rowsFor('expense', 'expense_log');
    expect(computeMetric(metricNamed('total_spend', 'expense_log'), rows).value).toBeCloseTo(763.9);
    expect(computeMetric(metricNamed('average_spend', 'expense_log'), rows).formatted).toBe(
      '152.78',
    );
  });

  it('returns n/a when nothing matches', () => {
    const result = computeMetric(metricNamed('total_spend', 'expense_log'), []);
    expect(result.value).toBeNull();
    expect(result.formatted).toBe('n/a');
    expect(result.matchedRows).toBe(0);
  });

  it('reports how many rows the filter matched', () => {
    const result = computeMetric(metricNamed('unread_books', 'book_tracker'), rowsFor('book'));
    expect(result.matchedRows).toBe(3);
  });
});

describe('formatting', () => {
  it('trims trailing zeros and caps at two decimals', () => {
    expect(formatNumber(3)).toBe('3');
    expect(formatNumber(3.5)).toBe('3.5');
    expect(formatNumber(3.14159)).toBe('3.14');
  });

  it('renders booleans as words and empty cells as blank', () => {
    const finished = book.fields.find((f) => f.id === 'finished')!;
    const author = book.fields.find((f) => f.id === 'author')!;
    expect(formatCellValue(true, finished)).toBe('Yes');
    expect(formatCellValue(false, finished)).toBe('No');
    expect(formatCellValue(null, author)).toBe('');
  });
});
