import { describe, expect, it } from 'vitest';
import { deepNormalisePunctuation, normalisePunctuation } from './normalise.js';

/** Referenced by code point so this file never contains the characters itself. */
const EM_DASH = String.fromCodePoint(0x2014);
const HORIZONTAL_BAR = String.fromCodePoint(0x2015);

describe('normalisePunctuation', () => {
  it('replaces a dash used as an aside', () => {
    expect(normalisePunctuation(`the property you mentioned${EM_DASH}the schema rejects it`)).toBe(
      'the property you mentioned - the schema rejects it',
    );
  });

  it('collapses spaces that already surrounded the dash', () => {
    expect(normalisePunctuation(`one ${EM_DASH} two`)).toBe('one - two');
    expect(normalisePunctuation(`one  ${EM_DASH}  two`)).toBe('one - two');
  });

  it('replaces the horizontal bar as well', () => {
    expect(normalisePunctuation(`a${HORIZONTAL_BAR}b`)).toBe('a - b');
  });

  it('handles several in one string', () => {
    expect(normalisePunctuation(`a${EM_DASH}b${EM_DASH}c`)).toBe('a - b - c');
  });

  it('leaves ordinary text alone', () => {
    const text = 'A hyphen-joined word, a colon: and a dash - already fine.';
    expect(normalisePunctuation(text)).toBe(text);
  });

  it('leaves an empty string alone', () => {
    expect(normalisePunctuation('')).toBe('');
  });
});

describe('deepNormalisePunctuation', () => {
  it('reaches strings at any depth', () => {
    const input = {
      app: { name: `Stock${EM_DASH}keeper` },
      components: [{ title: `Low${EM_DASH}stock`, nested: { caption: `a${EM_DASH}b` } }],
    };

    expect(deepNormalisePunctuation(input)).toEqual({
      app: { name: 'Stock - keeper' },
      components: [{ title: 'Low - stock', nested: { caption: 'a - b' } }],
    });
  });

  it('normalises object keys too, since a generated field id is a key', () => {
    const normalised = deepNormalisePunctuation({ [`a${EM_DASH}b`]: 1 });
    expect(Object.keys(normalised)).toEqual(['a - b']);
  });

  it('leaves numbers, booleans, null and undefined untouched', () => {
    const input = { n: 1, t: true, f: false, z: null, u: undefined };
    expect(deepNormalisePunctuation(input)).toEqual(input);
  });

  it('does not mutate what it was given', () => {
    const input = { title: `a${EM_DASH}b` };
    const output = deepNormalisePunctuation(input);

    expect(input.title).toContain(EM_DASH);
    expect(output.title).not.toContain(EM_DASH);
  });

  it('preserves array order and length', () => {
    expect(deepNormalisePunctuation(['a', `b${EM_DASH}c`, 'd'])).toEqual(['a', 'b - c', 'd']);
  });
});
