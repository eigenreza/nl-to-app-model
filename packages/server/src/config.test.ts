import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, apiKeyFor, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('runs on defaults with an empty environment', () => {
    const config = loadConfig({});

    expect(config.PORT).toBe(8787);
    expect(config.LLM_PROVIDER).toBe('gemini');
    expect(config.model).toBe(DEFAULT_MODELS.gemini);
    expect(config.DEMO_MODE).toBe('replay');
    expect(config.liveGenerationEnabled).toBe(false);
  });

  it('defaults to replay so a fresh deployment cannot spend anything', () => {
    expect(loadConfig({}).liveGenerationEnabled).toBe(false);
    expect(loadConfig({ DEMO_MODE: 'live' }).liveGenerationEnabled).toBe(true);
  });

  it('resolves the model per provider and lets an explicit value win', () => {
    expect(loadConfig({ LLM_PROVIDER: 'anthropic' }).model).toBe(DEFAULT_MODELS.anthropic);
    expect(loadConfig({ LLM_MODEL: 'gemini-2.0-flash' }).model).toBe('gemini-2.0-flash');
    expect(loadConfig({ LLM_MODEL: '   ' }).model).toBe(DEFAULT_MODELS.gemini);
  });

  it('coerces numeric variables from strings', () => {
    const config = loadConfig({ PORT: '3000', LLM_REQUESTS_PER_MINUTE: '2' });
    expect(config.PORT).toBe(3000);
    expect(config.LLM_REQUESTS_PER_MINUTE).toBe(2);
  });

  it('names the offending variable when a value is out of range', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/);
    expect(() => loadConfig({ RATE_LIMIT_MAX: 'lots' })).toThrow(/RATE_LIMIT_MAX/);
  });

  it('selects the credential that matches the provider', () => {
    expect(apiKeyFor(loadConfig({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }))).toBe('g');
    expect(
      apiKeyFor(
        loadConfig({ LLM_PROVIDER: 'anthropic', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }),
      ),
    ).toBe('a');
  });
});
