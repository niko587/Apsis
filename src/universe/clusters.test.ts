import { describe, expect, it } from 'vitest';
import { seedLeads } from '../domain/seed';
import { REGION_ORDER, STATE_REGION, stateOf } from '../domain/geography';
import {
  DIMENSIONS,
  DRILL_SEQUENCE,
  clusterChildren,
  matchesPath,
  nextDimension,
  stepLabel,
  type PathStep,
} from './clusters';

const NOW = 1_700_000_000_000;

/**
 * The full book, not a 500-lead sample.
 *
 * Membership assertions below name a specific city and segment, and with a
 * national book Tampa is ~1.4% of the leads — at n=500 the Tampa ∩ Family
 * Coverage intersection is legitimately empty, and the test would be asserting
 * a property of the sample size rather than of the code.
 */
const leads = seedLeads(4892, 0x5f3a21, NOW);

describe('cluster dimensions (§15)', () => {
  it('every dimension agrees with itself: matches(lead, keyFor(lead)) is true', () => {
    // Aggregate first, assert once. The obvious loop of expect() calls is
    // 5 dimensions × 4,892 leads × 2 ≈ 49k assertions, whose runtime is
    // framework overhead rather than the property under test — it timed out
    // on a loaded machine while the actual check takes milliseconds.
    const nullKeys: string[] = [];
    const disagreements: string[] = [];
    for (const dim of Object.values(DIMENSIONS)) {
      for (const lead of leads) {
        const key = dim.keyFor(lead);
        if (key === null) nullKeys.push(`${dim.id}:${lead.id}`);
        else if (!dim.matches(lead, key)) disagreements.push(`${dim.id}:${lead.id}`);
      }
    }
    expect(nullKeys.slice(0, 5)).toEqual([]);
    expect(disagreements.slice(0, 5)).toEqual([]);
  });

  it('drills Universe → region → state → city → segment', () => {
    expect(DRILL_SEQUENCE.map((d) => d.id)).toEqual([
      'region',
      'state',
      'city',
      'segment',
    ]);
    expect(nextDimension([])).toBe(DIMENSIONS.region);
    expect(nextDimension([{ dimensionId: 'region', key: 'South' }])).toBe(
      DIMENSIONS.state,
    );
    expect(
      nextDimension([
        { dimensionId: 'region', key: 'South' },
        { dimensionId: 'state', key: 'FL' },
      ]),
    ).toBe(DIMENSIONS.city);
  });

  it('path membership is the intersection of every step', () => {
    const path: PathStep[] = [
      { dimensionId: 'region', key: 'South' },
      { dimensionId: 'state', key: 'FL' },
      { dimensionId: 'city', key: 'Tampa, FL' },
      { dimensionId: 'segment', key: 'Family Coverage' },
    ];
    const members = leads.filter((l) => matchesPath(l, path));
    expect(members.length).toBeGreaterThan(0);
    for (const l of members) {
      expect(l.location).toBe('Tampa, FL');
      expect(l.segment).toBe('Family Coverage');
    }
    // And nothing outside the intersection sneaks in.
    expect(members.length).toBe(
      leads.filter((l) => l.location === 'Tampa, FL' && l.segment === 'Family Coverage')
        .length,
    );
  });

  it('child clusters partition the parent exactly — counts must sum to members', () => {
    let path: PathStep[] = [];
    while (nextDimension(path)) {
      const { children, members } = clusterChildren(leads, path);
      expect(children.reduce((n, c) => n + c.count, 0)).toBe(members);
      expect(children.length).toBeGreaterThan(0);
      // Descend into the largest child each time.
      path = [...path, { dimensionId: nextDimension(path)!.id, key: children[0].key }];
    }
    const deepest = clusterChildren(leads, path);
    expect(deepest.children).toEqual([]);
    expect(deepest.members).toBeGreaterThan(0);
  });

  it('labels the spec example path the way a human would say it', () => {
    expect(stepLabel({ dimensionId: 'region', key: 'South' })).toBe('South');
    expect(stepLabel({ dimensionId: 'state', key: 'FL' })).toBe('Florida');
    expect(stepLabel({ dimensionId: 'city', key: 'Tampa, FL' })).toBe('Tampa');
    expect(stepLabel({ dimensionId: 'segment', key: 'Family Coverage' })).toBe(
      'Family Coverage',
    );
  });
});

/**
 * The drill is only worth having if the levels actually divide the book. A
 * single-state book made `GLOBAL → Florida` a click that went from 4,892 leads
 * to 4,892 leads — structurally valid, and useless. These guard the property
 * that made it useless, not the implementation that fixed it.
 */
describe('the book is national (§15 needs something to partition)', () => {
  it('spans every census region and dozens of states', () => {
    const states = new Set(leads.map((l) => stateOf(l.location)));
    const regions = new Set(leads.map((l) => STATE_REGION[stateOf(l.location)]));
    expect(regions.size).toBe(REGION_ORDER.length);
    expect(states.size).toBeGreaterThan(40);
    expect(new Set(leads.map((l) => l.location)).size).toBeGreaterThan(50);
  });

  it('no drill level collapses to a single choice', () => {
    // Walk the largest branch; every level must offer a real decision.
    let path: PathStep[] = [];
    while (nextDimension(path)) {
      const { children } = clusterChildren(leads, path);
      expect(children.length).toBeGreaterThan(1);
      path = [...path, { dimensionId: nextDimension(path)!.id, key: children[0].key }];
    }
  });

  it('is weighted by population, not spread evenly', () => {
    const byState = new Map<string, number>();
    for (const l of leads) {
      const s = stateOf(l.location);
      byState.set(s, (byState.get(s) ?? 0) + 1);
    }
    const counts = [...byState.values()].sort((a, b) => b - a);
    // A uniform sprinkle would make every state the same size and the map
    // meaningless. The largest state should dwarf the median one.
    const median = counts[Math.floor(counts.length / 2)];
    expect(counts[0]).toBeGreaterThan(median * 5);
  });

  it('gives every lead an area code belonging to its own metro', () => {
    // A Tampa lead with a Seattle number is how a book announces it is fake.
    const seen = new Map<string, Set<string>>();
    for (const l of leads) {
      const area = l.phone.slice(1, 4);
      if (!seen.has(l.location)) seen.set(l.location, new Set());
      seen.get(l.location)!.add(area);
    }
    for (const [location, areas] of seen) {
      expect(areas.size, `${location} should have one area code`).toBe(1);
    }
  });
});
