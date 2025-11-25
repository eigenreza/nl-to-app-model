import { describe, expect, it } from 'vitest';
import { extractJsonObject } from './json.js';

describe('extractJsonObject', () => {
  it('parses a bare object without marking it recovered', () => {
    const result = extractJsonObject('{"a": 1}');
    expect(result).toEqual({ ok: true, value: { a: 1 }, recovered: false });
  });

  it('recovers an object from a fenced block', () => {
    const result = extractJsonObject('```json\n{"a": 1}\n```');
    expect(result.ok && result.value).toEqual({ a: 1 });
    expect(result.ok && result.recovered).toBe(true);
  });

  it('recovers an object from a fenced block with no language tag', () => {
    const result = extractJsonObject('```\n{"a": 1}\n```');
    expect(result.ok && result.value).toEqual({ a: 1 });
  });

  it('recovers an object introduced by prose', () => {
    const result = extractJsonObject(
      'Here is the model you asked for:\n{"a": 1}\nHope that helps.',
    );
    expect(result.ok && result.value).toEqual({ a: 1 });
    expect(result.ok && result.recovered).toBe(true);
  });

  it('ignores braces inside string values when balancing', () => {
    const raw = 'text {"title": "a {curly} name", "nested": {"b": 2}} trailing';
    const result = extractJsonObject(raw);
    expect(result.ok && result.value).toEqual({ title: 'a {curly} name', nested: { b: 2 } });
  });

  it('ignores an escaped quote inside a string', () => {
    const result = extractJsonObject('{"title": "say \\"hi\\" {"}');
    expect(result.ok && result.value).toEqual({ title: 'say "hi" {' });
  });

  it('fails on an empty response', () => {
    expect(extractJsonObject('   ')).toEqual({ ok: false, error: 'The response was empty.' });
  });

  it('fails when there is no object at all', () => {
    const result = extractJsonObject('I cannot help with that.');
    expect(result.ok).toBe(false);
  });

  it('fails on an object that never closes', () => {
    const result = extractJsonObject('{"a": 1');
    expect(result.ok).toBe(false);
  });
});
