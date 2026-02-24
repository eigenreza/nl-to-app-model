/**
 * Deciding how one request should be answered.
 *
 * The order matters and is the whole design: a recorded trace is tried first,
 * always, before any guard is consulted. That is what makes the sample prompts
 * work whatever else is true, including after the day's budget is gone. Only a
 * description nobody has recorded reaches the guards, and each guard is checked
 * in the order of how long its refusal lasts: never, until the day turns, until
 * tomorrow for this visitor, or until the current generation finishes.
 */
import type { LiveUnavailableReason } from '@nlam/shared';
import type { DailyBudget } from './daily-budget.js';
import type { LiveAccess } from './live-access.js';

export interface LiveGate {
  configured: boolean;
  budget?: DailyBudget | undefined;
  access?: LiveAccess | undefined;
}

export type LiveDecision =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: LiveUnavailableReason };

/** Whether live generation could be started at all, ignoring who is asking. */
export function liveAvailability(gate: LiveGate): {
  available: boolean;
  reason?: LiveUnavailableReason;
} {
  if (!gate.configured || !gate.budget) return { available: false, reason: 'not_configured' };
  if (!gate.budget.canStartGeneration()) return { available: false, reason: 'budget_exhausted' };
  return { available: true };
}

/**
 * Claims the right to run one live generation for this caller, or explains
 * why not. A caller that is allowed must call release when it is finished.
 */
export function claimLiveGeneration(gate: LiveGate, address: string): LiveDecision {
  const availability = liveAvailability(gate);
  if (!availability.available) {
    return { allowed: false, reason: availability.reason ?? 'not_configured' };
  }

  if (!gate.access) return { allowed: true, release: () => {} };

  const claim = gate.access.claim(address);
  if ('refused' in claim) return { allowed: false, reason: claim.refused };

  return { allowed: true, release: claim.release };
}
