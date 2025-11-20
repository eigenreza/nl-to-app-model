import { describe, expect, it } from 'vitest';
import type { Field } from '@nlam/shared';
import { coerceDraft } from './formValues.js';

const fields: Field[] = [
  { id: 'title', label: 'Title', type: 'string', required: true },
  { id: 'pages', label: 'Pages', type: 'number', required: false },
  { id: 'finished', label: 'Finished', type: 'boolean', required: false },
  { id: 'due', label: 'Due', type: 'date', required: false },
  { id: 'genre', label: 'Genre', type: 'enum', required: false, options: ['Fiction', 'History'] },
];

describe('coerceDraft', () => {
  it('converts each input string to the type the field declares', () => {
    const { values, errors } = coerceDraft(fields, {
      title: '  Piranesi  ',
      pages: '245',
      finished: 'true',
      due: '2024-05-01',
      genre: 'Fiction',
    });

    expect(errors).toEqual({});
    expect(values).toEqual({
      title: 'Piranesi',
      pages: 245,
      finished: true,
      due: '2024-05-01',
      genre: 'Fiction',
    });
  });

  it('treats an untouched form as empty rather than as zeroes', () => {
    const { values } = coerceDraft(fields, {});
    expect(values.pages).toBeNull();
    expect(values.genre).toBeNull();
    expect(values.finished).toBe(false);
  });

  it('reports missing required fields', () => {
    const { errors } = coerceDraft(fields, { title: '   ' });
    expect(errors.title).toBe('Title is required.');
  });

  it('rejects a number that does not parse', () => {
    const { errors, values } = coerceDraft(fields, { title: 'x', pages: 'many' });
    expect(errors.pages).toBe('Pages must be a number.');
    expect(values.pages).toBeNull();
  });

  it('rejects a date that is not a real calendar day', () => {
    const { errors } = coerceDraft(fields, { title: 'x', due: '2024-02-31' });
    expect(errors.due).toContain('YYYY-MM-DD');
  });

  it('rejects an enum value outside the declared options', () => {
    const { errors } = coerceDraft(fields, { title: 'x', genre: 'Poetry' });
    expect(errors.genre).toBe('Genre must be one of the listed options.');
  });

  it('accepts a negative or fractional number', () => {
    const { values, errors } = coerceDraft(fields, { title: 'x', pages: '-12.5' });
    expect(errors).toEqual({});
    expect(values.pages).toBe(-12.5);
  });
});
