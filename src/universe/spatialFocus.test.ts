/**
 * §14 spatial focus — the pure halves.
 *
 * The reticle and card are visual and live in the browser suite; what can be
 * proven here is the logic they both hang off: the focus predicate (which is
 * also what LeadField uses to stand its small marker down) and the screen-space
 * clamp that keeps the card inside the stage and off the command bar.
 */

import { describe, expect, it } from 'vitest';
import { clampCard, isIndividualFocus } from './SelectedLeadFocus';
import { DRILL_SEQUENCE, DIMENSIONS, type PathStep } from './clusters';
import { seedLeads } from '../domain/seed';
import { STATE_REGION, stateOf } from '../domain/geography';

const NOW = 1_700_000_000_000;
const leads = seedLeads(400, 0x5f3a21, NOW);
const lead = leads[0];

/** The full drill path that actually contains `lead` — built from its own fields. */
const pathTo = (l: (typeof leads)[number]): PathStep[] => [
  { dimensionId: 'region', key: STATE_REGION[stateOf(l.location)] },
  { dimensionId: 'state', key: stateOf(l.location) },
  { dimensionId: 'city', key: l.location },
  { dimensionId: 'segment', key: l.segment },
];

describe('isIndividualFocus — tier 2 of the contract state model', () => {
  it('is true only at full drill depth with a member lead', () => {
    const path = pathTo(lead);
    expect(path).toHaveLength(DRILL_SEQUENCE.length);
    expect(isIndividualFocus(lead, path)).toBe(true);
  });

  it('is false at any shallower depth — tier 1 must not fly the camera', () => {
    const path = pathTo(lead);
    for (let depth = 0; depth < DRILL_SEQUENCE.length; depth++) {
      expect(isIndividualFocus(lead, path.slice(0, depth))).toBe(false);
    }
  });

  it('is false when the lead is not a member of the drilled cluster', () => {
    const other = leads.find((l) => l.segment !== lead.segment)!;
    const path = pathTo(lead);
    expect(DIMENSIONS.segment.matches(other, lead.segment)).toBe(false);
    expect(isIndividualFocus(other, path)).toBe(false);
  });

  it('is false with no lead at all', () => {
    expect(isIndividualFocus(null, pathTo(lead))).toBe(false);
    expect(isIndividualFocus(undefined, pathTo(lead))).toBe(false);
  });
});

describe('clampCard — the card stays inside the stage and off the command bar', () => {
  const W = 1600;
  const H = 1000;
  const CW = 280;
  const CH = 100;

  it('sits to the right of the lead with clearance in open space', () => {
    const c = clampCard(800, 500, W, H, CW, CH, 880);
    expect(c.flipped).toBe(false);
    expect(c.x).toBeGreaterThan(800); // clear of the reticle
    expect(c.y).toBeCloseTo(500 - CH / 2, 5);
  });

  it('flips to the left when the right edge would clip', () => {
    const c = clampCard(W - 60, 500, W, H, CW, CH, 880);
    expect(c.flipped).toBe(true);
    expect(c.x + CW).toBeLessThanOrEqual(W - 12 + 0.001);
    expect(c.x).toBeLessThan(W - 60);
  });

  it('never crosses the command reserve line', () => {
    const reserveY = 880;
    const c = clampCard(800, H - 20, W, H, CW, CH, reserveY);
    expect(c.y + CH).toBeLessThanOrEqual(reserveY - 12 + 0.001);
  });

  it('never leaves the stage on any edge, even for corner positions', () => {
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H], [-50, -50], [W + 50, H + 50]] as const) {
      const c = clampCard(x, y, W, H, CW, CH, 880);
      expect(c.x).toBeGreaterThanOrEqual(12);
      expect(c.y).toBeGreaterThanOrEqual(12);
      expect(c.x + CW).toBeLessThanOrEqual(W - 12 + 0.001);
      expect(c.y + CH).toBeLessThanOrEqual(H + 0.001);
    }
  });

  it('holds inside a 46vh stacked stage', () => {
    // ≤820px layout: the stage is 46vh of a short screen — the tightest box
    // the card ever has to live in.
    const sw = 700;
    const sh = 414;
    const c = clampCard(650, 400, sw, sh, CW, CH, 340);
    expect(c.x).toBeGreaterThanOrEqual(12);
    expect(c.x + CW).toBeLessThanOrEqual(sw - 12 + 0.001);
    expect(c.y + CH).toBeLessThanOrEqual(340 - 12 + 0.001);
  });
});
