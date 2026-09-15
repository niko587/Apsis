/**
 * Lead Gravity: the map from score to position in the Universe.
 *
 * This module is the joint between the domain and the 3D layer, and it only ever
 * points one way — score in, position out. The renderer calls this; nothing here
 * calls the renderer. That is what keeps §27 rule 4 honest: the 3D layer cannot
 * drift away from application state because it has no state of its own to drift
 * with.
 */

import { STAGES, STAGE_ORDER, type Lead, type Score, type Stage } from './types';
import { clampScore, stageFor } from './scoring';

/** Radius of the cold rim, in world units. The Universe is sized around this. */
export const APOAPSIS = 10;
/**
 * Booked leads converge here rather than to the exact origin. The origin belongs
 * to the Intelligence Core; the appointment ring sits just outside it, which is
 * also what stops every booked lead from occupying one z-fighting point.
 */
export const PERIAPSIS = 0.85;

/**
 * Fractional progress along the whole cold → booked journey, in [0, 1].
 *
 * Deliberately computed from *stage index plus progress within stage* rather
 * than straight from score. The score bands are uneven by design (cold spans 20
 * points, booked spans 1), so a direct score→radius map would squeeze the four
 * late stages into a sliver and the Universe would read as one fat cold ring.
 * Giving each stage an equal annulus makes every stage legible as a ring, and
 * within-stage movement still shows as drift inside that ring.
 */
export function journey(score: Score): number {
  const s = clampScore(score);
  const stage = stageFor(s);
  const spec = STAGES[stage];
  const idx = STAGE_ORDER.indexOf(stage);
  const span = spec.hi - spec.lo;
  const frac = span <= 0 ? 1 : (s - spec.lo) / span;
  return (idx + frac) / STAGE_ORDER.length;
}

/** Inverse of {@link journey}: fractional progress back to a score. */
export function scoreAtJourney(t: number): Score {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * STAGE_ORDER.length;
  const idx = Math.min(STAGE_ORDER.length - 1, Math.floor(scaled));
  const spec = STAGES[STAGE_ORDER[idx]];
  return clampScore(spec.lo + (scaled - idx) * (spec.hi - spec.lo));
}

/**
 * Orbital radius for a score.
 *
 * The mild exponent widens the outer annuli and tightens the inner ones, so the
 * many cold leads have room to spread while the approach to periapsis reads as a
 * well. Monotonically decreasing: more score is always closer, never further.
 */
export function radiusFor(score: Score): number {
  const t = journey(score);
  const eased = Math.pow(1 - t, 1.22);
  return PERIAPSIS + (APOAPSIS - PERIAPSIS) * eased;
}

/**
 * Inverse of {@link radiusFor}, for picking and camera framing.
 *
 * Must undo BOTH steps — the easing and the stage-indexed journey. Inverting only
 * the easing and treating the result as `score / 100` silently skews every
 * radius→score reading, because the journey is piecewise over uneven bands.
 */
export function scoreAtRadius(radius: number): number {
  const clamped = Math.max(PERIAPSIS, Math.min(APOAPSIS, radius));
  const eased = (clamped - PERIAPSIS) / (APOAPSIS - PERIAPSIS);
  return scoreAtJourney(1 - Math.pow(eased, 1 / 1.22));
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * World position for a lead.
 *
 * `theta` and `inclination` are assigned once at ingest and never change, so a
 * lead's angular identity is stable — you can watch one specific lead travel
 * inward without it also sliding around the disc. Only the radius moves, and the
 * radius is a pure function of score.
 *
 * Inclination is flattened near the center so the Universe reads as a disc at the
 * rim and funnels into a focused plane at the appointment ring.
 */
export function positionFor(lead: Pick<Lead, 'score' | 'theta' | 'inclination'>): Vec3 {
  const r = radiusFor(lead.score);
  const flatten = (r - PERIAPSIS) / (APOAPSIS - PERIAPSIS);
  const incl = lead.inclination * flatten;
  const horizontal = r * Math.cos(incl);
  return {
    x: horizontal * Math.cos(lead.theta),
    y: r * Math.sin(incl),
    z: horizontal * Math.sin(lead.theta),
  };
}

/** Stage colour, for the 3D layer and every legend that must agree with it. */
export function colorFor(stage: Stage): string {
  return STAGES[stage].color;
}
