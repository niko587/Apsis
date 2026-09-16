/**
 * Availability and next-dimension resolution.
 *
 * The first test in this file is the most important one in the milestone: it
 * passes a ONE-SHOT generator. `availableDimensions` is called in production
 * with `leads.values()`, a single-pass Map iterator, so the obvious
 * `for (dimension) for (lead)` implementation would let only the first
 * dimension see the book and silently report every other one as unavailable.
 * The symptom would be a picker that only ever offers `region`, with nothing in
 * the code looking wrong — which is exactly the kind of bug that needs a test
 * written before the implementation it guards.
 */

import { describe, expect, it } from 'vitest';
import {
  DIMENSIONS,
  DRILL_SEQUENCE,
  MAX_DRILL_DEPTH,
  availableDimensions,
  clusterChildren,
  effectiveNextDimension,
  matchesPath,
  type PathStep,
} from './clusters';
import { seedLeads } from '../domain/seed';
import type { Lead } from '../domain/types';

const BOOK = seedLeads(4892);
const ids = (dims: { id: string }[]) => dims.map((d) => d.id);

/** Single-pass on purpose. A second traversal yields nothing. */
function* oneShot(leads: readonly Lead[]): Generator<Lead> {
  for (const lead of leads) yield lead;
}

const step = (dimensionId: string, key: string): PathStep => ({ dimensionId, key });

describe('availableDimensions traverses its iterable exactly once (D53)', () => {
  it('finds every eligible dimension when given a ONE-SHOT generator', () => {
    const fromArray = ids(availableDimensions(BOOK, []));
    const fromGenerator = ids(availableDimensions(oneShot(BOOK), []));
    expect(fromGenerator).toEqual(fromArray);
    expect(fromGenerator.length).toBeGreaterThan(1);
  });

  it('works with a real Map iterator, which is what production passes', () => {
    const map = new Map(BOOK.map((l) => [l.id, l]));
    expect(ids(availableDimensions(map.values(), []))).toEqual(ids(availableDimensions(BOOK, [])));
  });

  it('consumes the iterable exactly once, counted', () => {
    let passes = 0;
    const counted: Iterable<Lead> = {
      [Symbol.iterator]() {
        passes++;
        return oneShot(BOOK);
      },
    };
    availableDimensions(counted, []);
    expect(passes, 'more than one pass means a multi-pass implementation').toBe(1);
  });

  it('visits each lead once, not once per dimension', () => {
    // A dimension-outer loop would read the book nine times over.
    let reads = 0;
    function* counting(): Generator<Lead> {
      for (const lead of BOOK) {
        reads++;
        yield lead;
      }
    }
    availableDimensions(counting(), []);
    expect(reads).toBe(BOOK.length);
  });
});

describe('a dimension is offered only when it splits the cluster (D49)', () => {
  it('offers the splitting dimensions at GLOBAL', () => {
    const available = ids(availableDimensions(BOOK, []));
    expect(available).toContain('region');
    expect(available).toContain('city');
    expect(available).toContain('temperature');
    // Registry order, not child count — a menu that reshuffles as the feed
    // lands is a menu nobody can learn.
    expect(available).toEqual([...available].sort(
      (a, b) => Object.keys(DIMENSIONS).indexOf(a) - Object.keys(DIMENSIONS).indexOf(b),
    ));
  });

  it('hides a dimension already used in the path — no "used" set required', () => {
    const path = [step('segment', 'Medicare')];
    expect(ids(availableDimensions(BOOK, path))).not.toContain('segment');
  });

  it('hides the coarser half of nested geography — no special case required', () => {
    // `region` after `state`: every member of Colorado is in the West.
    expect(ids(availableDimensions(BOOK, [step('state', 'CO')]))).not.toContain('region');
    // `state` after `city`: every member of Tampa, FL is in Florida.
    const city = [step('city', 'Tampa, FL')];
    expect(ids(availableDimensions(BOOK, city))).not.toContain('state');
    expect(ids(availableDimensions(BOOK, city))).not.toContain('region');
  });

  it('still offers the finer half of nested geography', () => {
    expect(ids(availableDimensions(BOOK, [step('region', 'West')]))).toContain('state');
    expect(ids(availableDimensions(BOOK, [step('region', 'West')]))).toContain('city');
  });

  it('offers nothing for an empty cluster', () => {
    const empty = [step('state', 'CO'), step('city', 'Tampa, FL')];
    expect(availableDimensions(BOOK, empty)).toEqual([]);
  });

  it('offers nothing for a single-member cluster', () => {
    const one = BOOK[0]!;
    const path = [
      step('city', one.location),
      step('segment', one.segment),
      step('campaign', one.campaign),
      step('source', one.acquisitionSource),
    ];
    const members = BOOK.filter((l) => matchesPath(l, path));
    if (members.length === 1) expect(availableDimensions(BOOK, path)).toEqual([]);
  });
});

describe('agent is absent on a fresh book, and that is correct (§F.1)', () => {
  it('is NOT offered when every lead is Unassigned', () => {
    // Seeded leads carry ownerAgentId: null, so agent has exactly one child.
    // Offering it would claim a partition the data does not have.
    expect(BOOK.every((l) => l.ownerAgentId === null)).toBe(true);
    expect(ids(availableDimensions(BOOK, []))).not.toContain('agent');
  });

  it('becomes offered once a second ownership bucket exists', () => {
    // A focused fixture with two real ownership keys — NOT fabricated seed
    // data, and no special case in the picker.
    const owned: Lead[] = [
      { ...BOOK[0]!, ownerAgentId: 'agent_call' },
      { ...BOOK[1]!, ownerAgentId: null },
    ];
    expect(ids(availableDimensions(owned, []))).toContain('agent');
  });

  it('keeps Unassigned as a real bucket rather than dropping those leads', () => {
    const owned: Lead[] = [
      { ...BOOK[0]!, ownerAgentId: 'agent_call' },
      { ...BOOK[1]!, ownerAgentId: null },
    ];
    const { children, members } = clusterChildren(owned, [], DIMENSIONS.agent!);
    expect(members).toBe(2);
    expect(children.map((c) => c.label).sort()).toEqual(['Call Agent', 'Unassigned']);
    expect(children.reduce((n, c) => n + c.count, 0)).toBe(members);
  });
});

describe('effectiveNextDimension is the single decision (D52)', () => {
  it('follows the default chain when nothing is selected', () => {
    expect(effectiveNextDimension(BOOK, [], null).dimension?.id).toBe('region');
    expect(effectiveNextDimension(BOOK, [step('region', 'West')], null).dimension?.id).toBe('state');
    const toCity = [step('region', 'West'), step('state', 'CO')];
    expect(effectiveNextDimension(BOOK, toCity, null).dimension?.id).toBe('city');
    const toSegment = [...toCity, step('city', 'Denver, CO')];
    expect(effectiveNextDimension(BOOK, toSegment, null).dimension?.id).toBe('segment');
  });

  it('is terminal at MAX_DRILL_DEPTH', () => {
    const full = [
      step('region', 'West'),
      step('state', 'CO'),
      step('city', 'Denver, CO'),
      step('segment', 'Medicare'),
    ];
    expect(full.length).toBe(MAX_DRILL_DEPTH);
    expect(effectiveNextDimension(BOOK, full, null).dimension).toBeNull();
    // Even an explicit selection cannot extend past the terminal depth.
    expect(effectiveNextDimension(BOOK, full, 'campaign').dimension).toBeNull();
  });

  it('SKIPS a depth default that is already determined — City then State', () => {
    // Depth 1's raw default is `state`, but the city has already determined it.
    const path = [step('city', 'Tampa, FL')];
    const resolved = effectiveNextDimension(BOOK, path, null);
    expect(resolved.dimension?.id).not.toBe('state');
    expect(ids(resolved.available)).not.toContain('state');
    expect(resolved.dimension?.id).toBe(ids(resolved.available)[0]);
  });

  it('SKIPS a depth default that is already used — Agent → Timeframe → Segment', () => {
    // Depth 3's raw default is `segment`, consumed at depth 2.
    const owned = BOOK.map((l, i) => ({
      ...l,
      ownerAgentId: i % 2 === 0 ? 'agent_call' : null,
    }));
    const path = [
      step('agent', 'agent_call'),
      step('timeframe', 'older'),
      step('segment', 'Medicare'),
    ];
    const resolved = effectiveNextDimension(owned, path, null);
    expect(resolved.dimension?.id).not.toBe('segment');
    if (resolved.dimension) expect(ids(resolved.available)).toContain(resolved.dimension.id);
  });

  it('honours a selection while it remains available', () => {
    const resolved = effectiveNextDimension(BOOK, [], 'temperature');
    expect(resolved.dimension?.id).toBe('temperature');
  });

  it('falls back when a selection has STOPPED being available, without touching path', () => {
    const path = [step('city', 'Tampa, FL')];
    const before = [...path];
    // `state` is determined by the city, so a stale selection of it is dead.
    const resolved = effectiveNextDimension(BOOK, path, 'state');
    expect(resolved.dimension?.id).not.toBe('state');
    expect(path).toEqual(before);
  });

  it('falls back for an unknown selection id', () => {
    expect(effectiveNextDimension(BOOK, [], 'not_a_dimension').dimension?.id).toBe('region');
  });

  it('returns null when nothing can split, and an empty availability list', () => {
    const empty = [step('state', 'CO'), step('city', 'Tampa, FL')];
    const resolved = effectiveNextDimension(BOOK, empty, null);
    expect(resolved.dimension).toBeNull();
    expect(resolved.available).toEqual([]);
  });

  it('returns the availability list it used, so nobody recomputes it', () => {
    const resolved = effectiveNextDimension(BOOK, [], null);
    expect(ids(resolved.available)).toEqual(ids(availableDimensions(BOOK, [])));
    expect(ids(resolved.available)).toContain(resolved.dimension!.id);
  });
});

describe('depth is independent of the default chain (D50)', () => {
  it('MAX_DRILL_DEPTH is 4', () => {
    expect(MAX_DRILL_DEPTH).toBe(4);
  });

  it('the CURRENT default chain is region → state → city → segment', () => {
    expect(DRILL_SEQUENCE.map((d) => d.id)).toEqual(['region', 'state', 'city', 'segment']);
  });

  // There is deliberately NO test asserting
  // `MAX_DRILL_DEPTH === DRILL_SEQUENCE.length`. They are both four today by
  // coincidence of the current suggestions; asserting it would re-couple the
  // concepts the constant exists to separate, so that adding a fifth default
  // grouping would silently redefine when §14 focus engages.
});

describe('mixed dynamic paths partition exactly', () => {
  it('matchesPath is correct across dimensions', () => {
    const path = [
      step('campaign', BOOK[0]!.campaign),
      step('temperature', BOOK[0]!.stage),
    ];
    for (const lead of BOOK) {
      const expected =
        lead.campaign === BOOK[0]!.campaign && lead.stage === BOOK[0]!.stage;
      expect(matchesPath(lead, path)).toBe(expected);
    }
  });

  it('every offered dimension accounts for the WHOLE parent cluster', () => {
    const path = [step('region', 'West')];
    const members = BOOK.filter((l) => matchesPath(l, path)).length;
    for (const dim of availableDimensions(BOOK, path)) {
      const { children, members: seen } = clusterChildren(BOOK, path, dim);
      expect(seen, dim.id).toBe(members);
      expect(children.reduce((n, c) => n + c.count, 0), dim.id).toBe(members);
    }
  });
});

/**
 * The terminal-size measurement (D54).
 *
 * Progressive reveal recorded that a full-depth cluster never exceeds 81
 * members, so the roster's 150-row cap could not truncate one. That was measured
 * for the FIXED default sequence. Dynamic paths invalidate it, so this
 * enumerates every reachable four-step path under the availability rules and
 * pins what it finds.
 *
 * IT DOES NOT ASSERT `<= 150`. That would be asserting something known to be
 * false. Its job is to make a change in the book, the dimensions or the rules
 * re-open the §L decision instead of drifting silently past it.
 */
describe('largest reachable four-step terminal cluster (D54)', () => {
  it('is 266, via Northeast → New York → New York, NY → Cold', () => {
    const byDimension = (members: Lead[], dim: { keyFor: (l: Lead) => string | null }) => {
      const buckets = new Map<string, Lead[]>();
      for (const lead of members) {
        const key = dim.keyFor(lead);
        if (key === null) continue;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(lead);
        else buckets.set(key, [lead]);
      }
      return buckets;
    };

    let best = 0;
    let bestPath = '';

    const walk = (members: Lead[], path: PathStep[]) => {
      if (path.length === MAX_DRILL_DEPTH) {
        if (members.length > best) {
          best = members.length;
          bestPath = path.map((p) => `${p.dimensionId}=${p.key}`).join(' > ');
        }
        return;
      }
      // Cluster sizes only shrink, so a branch already at or below the best
      // cannot beat it.
      if (members.length <= best) return;
      for (const dim of availableDimensions(members, path)) {
        for (const [key, bucket] of byDimension(members, dim)) {
          walk(bucket, [...path, { dimensionId: dim.id, key }]);
        }
      }
    };

    walk(BOOK, []);

    expect(best).toBe(266);
    expect(bestPath).toBe(
      'region=Northeast > state=NY > city=New York, NY > temperature=cold',
    );
    // The point of the number: it is ABOVE the roster cap, so the roster
    // truncates and must say so. See LeadList's `showing X of Y` header.
    expect(best).toBeGreaterThan(150);
  }, 120_000);
});
