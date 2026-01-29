/**
 * Punctuation normalisation for generated text.
 *
 * This project keeps to a restricted punctuation set so that hand-written
 * prose, source code and generated content all look the same in diffs,
 * terminals and fixtures. Anything a language model writes can carry
 * typographic dashes, and that text does not stay on screen: it is written into
 * eval results, into replay fixtures and into the application models the
 * renderer displays.
 *
 * So it is normalised once, at the boundary where a generation is finished,
 * rather than being caught later by a repository check that can only say a file
 * is wrong and not fix it. The substitution is a spaced hyphen, which is the
 * one replacement that reads correctly wherever a dash was being used, whether
 * it was joining clauses or marking an aside.
 */

/** Characters replaced, by code point, so this file never contains them. */
const REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  // Em dash and horizontal bar, with any surrounding spaces collapsed.
  [new RegExp(`\\s*[${String.fromCodePoint(0x2014)}${String.fromCodePoint(0x2015)}]\\s*`, 'g'), ' - '],
];

export function normalisePunctuation(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Applies the same normalisation to every string in a structure, returning a
 * copy. Object keys are normalised too: a generated field id is a key, and a
 * key nothing else knows about is still a key that gets written to disk.
 */
export function deepNormalisePunctuation<T>(value: T): T {
  if (typeof value === 'string') return normalisePunctuation(value) as T;

  if (Array.isArray(value)) {
    return value.map((entry) => deepNormalisePunctuation(entry)) as T;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[normalisePunctuation(key)] = deepNormalisePunctuation(entry);
    }
    return out as T;
  }

  return value;
}
