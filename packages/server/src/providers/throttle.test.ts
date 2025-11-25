import { describe, expect, it, vi } from 'vitest';
import { RateLimiter, ThrottledProvider, withRetry } from './throttle.js';
import { ProviderError } from './types.js';
import { ScriptedProvider, textTurn } from './scripted.js';

/** A clock the test advances by hand, so pacing is verified without waiting. */
function fakeClock() {
  let current = 0;
  const waits: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      waits.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    waits,
  };
}

describe('RateLimiter', () => {
  it('lets the first request through immediately', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 6, now: clock.now, sleep: clock.sleep });

    await limiter.acquire();
    expect(clock.waits).toEqual([]);
  });

  it('spaces later requests by the configured interval', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 6, now: clock.now, sleep: clock.sleep });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Six per minute is one every ten seconds.
    expect(clock.waits).toEqual([10_000, 10_000]);
  });

  it('does not make a caller wait when the interval has already elapsed', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 6, now: clock.now, sleep: clock.sleep });

    await limiter.acquire();
    clock.advance(30_000);
    await limiter.acquire();

    expect(clock.waits).toEqual([]);
  });

  it('serialises concurrent callers instead of releasing them together', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 60, now: clock.now, sleep: clock.sleep });

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    expect(clock.waits).toEqual([1_000, 1_000]);
  });
});

describe('withRetry', () => {
  const retryable = () =>
    new ProviderError('rate limited', { provider: 't', status: 429, retryable: true });

  it('returns the first successful result', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, { maxRetries: 3, sleep: async () => {} })).resolves.toBe(
      'ok',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and then succeeds', async () => {
    const operation = vi.fn().mockRejectedValueOnce(retryable()).mockResolvedValue('ok');
    const sleep = vi.fn(async () => {});

    await expect(withRetry(operation, { maxRetries: 3, sleep, random: () => 0.5 })).resolves.toBe(
      'ok',
    );

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure marked permanent', async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new ProviderError('bad request', { provider: 't', status: 400 }));

    await expect(withRetry(operation, { maxRetries: 3, sleep: async () => {} })).rejects.toThrow(
      'bad request',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up once the retry budget is spent', async () => {
    const operation = vi.fn().mockRejectedValue(retryable());

    await expect(
      withRetry(operation, { maxRetries: 2, sleep: async () => {}, random: () => 1 }),
    ).rejects.toThrow('rate limited');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially with jitter inside the expected band', async () => {
    const delays: number[] = [];
    const operation = vi.fn().mockRejectedValue(retryable());

    await expect(
      withRetry(operation, {
        maxRetries: 3,
        baseDelayMs: 1_000,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 1,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it('honours the delay cap', async () => {
    const delays: number[] = [];
    const operation = vi.fn().mockRejectedValue(retryable());

    await expect(
      withRetry(operation, {
        maxRetries: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 1,
      }),
    ).rejects.toThrow();

    expect(Math.max(...delays)).toBe(3_000);
  });

  it('wraps an unexpected error so callers only ever see ProviderError', async () => {
    const operation = vi.fn().mockRejectedValue(new TypeError('boom'));
    await expect(
      withRetry(operation, { maxRetries: 0, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('ThrottledProvider', () => {
  it('paces calls and passes results straight through', async () => {
    const clock = fakeClock();
    const inner = new ScriptedProvider([textTurn('one'), textTurn('two')]);
    const provider = new ThrottledProvider(inner, {
      limiter: new RateLimiter({ requestsPerMinute: 6, now: clock.now, sleep: clock.sleep }),
      retry: { maxRetries: 0, sleep: clock.sleep },
    });

    const first = await provider.complete({ system: '', messages: [] });
    const second = await provider.complete({ system: '', messages: [] });

    expect([first.text, second.text]).toEqual(['one', 'two']);
    expect(clock.waits).toEqual([10_000]);
    expect(provider.name).toBe('scripted');
  });

  it('retries through the limiter so a retry is paced too', async () => {
    const clock = fakeClock();
    const inner = new ScriptedProvider([
      new ProviderError('rate limited', { provider: 'scripted', status: 429, retryable: true }),
      textTurn('recovered'),
    ]);
    const provider = new ThrottledProvider(inner, {
      limiter: new RateLimiter({ requestsPerMinute: 60, now: clock.now, sleep: clock.sleep }),
      retry: { maxRetries: 2, sleep: clock.sleep, random: () => 1 },
    });

    const result = await provider.complete({ system: '', messages: [] });

    expect(result.text).toBe('recovered');
    expect(inner.callCount).toBe(2);
  });
});
