import { beforeEach, describe, expect, it } from 'vitest';
import { LiveAccess } from './live-access.js';
import { claimLiveGeneration, liveAvailability } from './live-decision.js';

let clock: Date;

beforeEach(() => {
  clock = new Date('2026-03-10T09:00:00.000Z');
});

function access(perAddressPerDay = 3, maxConcurrent = 1) {
  return new LiveAccess({ perAddressPerDay, maxConcurrent, now: () => clock });
}

describe('per address allowance', () => {
  it('allows exactly the configured number per day', () => {
    const guard = access(3);

    for (let i = 0; i < 3; i += 1) {
      const claim = guard.claim('1.2.3.4');
      expect('release' in claim).toBe(true);
      if ('release' in claim) claim.release();
    }

    expect(guard.claim('1.2.3.4')).toEqual({ refused: 'rate_limited' });
  });

  it('counts addresses separately', () => {
    const guard = access(1);

    const first = guard.claim('1.1.1.1');
    if ('release' in first) first.release();

    expect(guard.claim('1.1.1.1')).toEqual({ refused: 'rate_limited' });

    const other = guard.claim('2.2.2.2');
    expect('release' in other).toBe(true);
  });

  it('spends the allowance on asking, not on succeeding', () => {
    const guard = access(1);
    const claim = guard.claim('1.2.3.4');
    if ('release' in claim) claim.release(); // as if the generation had failed

    expect(guard.remainingFor('1.2.3.4')).toBe(0);
  });

  it('returns the allowance when the UTC day turns', () => {
    const guard = access(1);
    const claim = guard.claim('1.2.3.4');
    if ('release' in claim) claim.release();
    expect(guard.remainingFor('1.2.3.4')).toBe(0);

    clock = new Date('2026-03-11T00:00:01.000Z');
    expect(guard.remainingFor('1.2.3.4')).toBe(1);
  });
});

describe('concurrency', () => {
  it('runs one at a time by default', () => {
    const guard = access(10, 1);

    const first = guard.claim('1.1.1.1');
    expect('release' in first).toBe(true);
    expect(guard.claim('2.2.2.2')).toEqual({ refused: 'busy' });

    if ('release' in first) first.release();
    expect('release' in guard.claim('2.2.2.2')).toBe(true);
  });

  it('refuses on concurrency before spending an allowance', () => {
    const guard = access(1, 1);
    const held = guard.claim('1.1.1.1');
    expect('release' in held).toBe(true);

    // Refused for being busy, so this address keeps its allowance for later.
    expect(guard.claim('2.2.2.2')).toEqual({ refused: 'busy' });
    expect(guard.remainingFor('2.2.2.2')).toBe(1);
  });

  it('ignores a slot released twice', () => {
    const guard = access(10, 1);
    const claim = guard.claim('1.1.1.1');
    if (!('release' in claim)) throw new Error('expected a slot');

    claim.release();
    claim.release();

    expect(guard.concurrentInFlight).toBe(0);
    expect('release' in guard.claim('2.2.2.2')).toBe(true);
    expect(guard.concurrentInFlight).toBe(1);
  });
});

describe('the decision as a whole', () => {
  const exhaustedBudget = {
    canStartGeneration: () => false,
    canMakeCall: () => false,
    snapshot: () => ({ spentUsd: 0.3, capUsd: 0.3 }),
  } as never;

  const openBudget = {
    canStartGeneration: () => true,
    canMakeCall: () => true,
    snapshot: () => ({ spentUsd: 0, capUsd: 0.3 }),
  } as never;

  it('reports not configured when live was never set up', () => {
    expect(liveAvailability({ configured: false })).toEqual({
      available: false,
      reason: 'not_configured',
    });
  });

  it('reports the exhausted budget before consulting anything else', () => {
    const guard = access(3, 1);
    const decision = claimLiveGeneration(
      { configured: true, budget: exhaustedBudget, access: guard },
      '1.2.3.4',
    );

    expect(decision).toEqual({ allowed: false, reason: 'budget_exhausted' });
    // The refusal came before the allowance was touched.
    expect(guard.remainingFor('1.2.3.4')).toBe(3);
  });

  it('allows a claim when budget and guards are both content', () => {
    const decision = claimLiveGeneration(
      { configured: true, budget: openBudget, access: access(3, 1) },
      '1.2.3.4',
    );
    expect(decision.allowed).toBe(true);
  });

  it('passes the refusal through from the access guard', () => {
    const guard = access(1, 1);
    const held = guard.claim('9.9.9.9');
    expect('release' in held).toBe(true);

    expect(
      claimLiveGeneration({ configured: true, budget: openBudget, access: guard }, '1.2.3.4'),
    ).toEqual({ allowed: false, reason: 'busy' });
  });
});
