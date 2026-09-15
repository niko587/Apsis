/**
 * The Lead Gravity scoring engine.
 *
 * Pure functions only. Given a lead's current score and an event, produce the
 * next score. No clocks are read here and no randomness is used, so the whole
 * engine is deterministic and testable: the same event sequence always yields
 * the same score.
 *
 * This is the piece §27 rule 3 is about. Leads move because score changed, and
 * score changes only here.
 */

import {
  STAGES,
  STAGE_ORDER,
  TOUCH_CEILING,
  type LeadEventKind,
  type Score,
  type Stage,
} from './types';

/**
 * Score delta per event kind.
 *
 * Negative deltas matter as much as positive ones: a lead that objects or goes
 * quiet must visibly drift back outward, or the universe is just a one-way
 * decoration. `appointment_booked` is absolute rather than a delta — see below.
 */
const DELTA: Readonly<Record<LeadEventKind, number>> = {
  ingested: 0,
  contacted: +14,
  opened: +4,
  clicked: +7,
  replied: +16,
  call_connected: +19,
  call_no_answer: -3,
  qualified: +22,
  objection: -11,
  appointment_offered: +9,
  appointment_booked: 0, // absolute, handled in applyEvent
  appointment_cancelled: -26,
  went_cold: -18,
  unsubscribed: -100,
};

/** Events that pin the score to an exact value rather than nudging it. */
const ABSOLUTE: Partial<Record<LeadEventKind, Score>> = {
  appointment_booked: 100,
  unsubscribed: 0,
};

export const clampScore = (n: number): Score => Math.max(0, Math.min(100, n));

/** Score above which positive events start to cost more. Top of `qualified`. */
const DAMPING_ONSET = STAGES.hot.lo;

/**
 * Diminishing returns in the late funnel.
 *
 * Without this, four replies in a row would rocket a lead from cold to booked and
 * the center would lose its meaning. Below the hot band nothing is damped; from
 * there positive deltas scale linearly to zero at TOUCH_CEILING, so engagement
 * asymptotes just short of `booked` and can never enter it.
 *
 * The earlier version scaled by a factor that bottomed out at 0.28 rather than 0,
 * which merely *slowed* the climb to 100 — enough replies still reached periapsis
 * with no appointment ever booked, which is precisely the outcome the center is
 * supposed to mean.
 */
function damp(current: Score, delta: number): number {
  if (delta <= 0) return delta;
  if (current < DAMPING_ONSET) return delta;
  const headroom = (TOUCH_CEILING - current) / (TOUCH_CEILING - DAMPING_ONSET);
  return delta * Math.max(0, Math.min(1, headroom));
}

export function applyEvent(current: Score, kind: LeadEventKind): Score {
  const absolute = ABSOLUTE[kind];
  if (absolute !== undefined) return absolute;
  return clampScore(current + damp(current, DELTA[kind]));
}

/** Derive stage from score. Stage is never stored independently. */
export function stageFor(score: Score): Stage {
  const s = clampScore(score);
  for (const id of STAGE_ORDER) {
    const { lo, hi } = STAGES[id];
    if (s >= lo && s < hi) return id;
  }
  // Only score exactly 100 reaches here: `booked.hi` is the one inclusive bound.
  return 'booked';
}

/**
 * Time decay.
 *
 * A lead nobody has touched in weeks is not as warm as its last event implied.
 * Applied by the store on a coarse cadence, not per frame — the decay changes
 * the *score*, and the visual follows from that, so this is still state-driven
 * movement rather than an animation timer.
 *
 * Booked leads never decay: the appointment is a settled fact.
 */
const DECAY_GRACE_MS = 1000 * 60 * 60 * 72; // 72h before decay starts
const DECAY_POINTS_PER_DAY = 2.5;

export function decayedScore(score: Score, lastEventAt: number, now: number): Score {
  if (score >= STAGES.booked.lo) return score;
  const idle = now - lastEventAt;
  if (idle <= DECAY_GRACE_MS) return score;
  const days = (idle - DECAY_GRACE_MS) / (1000 * 60 * 60 * 24);
  return clampScore(score - days * DECAY_POINTS_PER_DAY);
}
