/**
 * Getting a JSON object out of a model response.
 *
 * Even with JSON mode requested, responses arrive wrapped in code fences or
 * with a sentence of commentary in front often enough that treating
 * JSON.parse as the whole story loses generations that were actually correct.
 * This recovers those without being so permissive that it hides real failures:
 * it only ever trims fences and takes the outermost balanced object.
 */

export type JsonExtraction =
  { ok: true; value: unknown; recovered: boolean } | { ok: false; error: string };

const FENCE = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```\s*$/i;

export function extractJsonObject(raw: string): JsonExtraction {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'The response was empty.' };

  const direct = tryParse(text);
  if (direct.ok) return { ok: true, value: direct.value, recovered: false };

  const fenced = FENCE.exec(text);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1].trim());
    if (inner.ok) return { ok: true, value: inner.value, recovered: true };
  }

  const balanced = outermostObject(text);
  if (balanced) {
    const parsed = tryParse(balanced);
    if (parsed.ok) return { ok: true, value: parsed.value, recovered: true };
  }

  return { ok: false, error: direct.error };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Returns the substring from the first brace to its matching close, skipping
 * braces that appear inside string literals so that content such as
 * "a {curly} title" does not throw the count off.
 */
function outermostObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}
