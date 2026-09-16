/**
 * §15 drill dimensions: campaign, source, agent, timeframe.
 *
 * Two things are under test. First the domain fields — deterministic, weighted,
 * and crucially *independent of the seeded RNG stream*, which is what lets them
 * be added without invalidating a single persisted session. Second the registry
 * entries, which must **partition** their parent set: every lead in exactly one
 * child, counts summing exactly to the parent, nothing dropped.
 *
 * The partition property is the whole point of a drill dimension. A grouping
 * that quietly loses leads shows a user a book smaller than the one they have,
 * and no amount of the UI looking right would reveal it.
 */

import { describe, expect, it } from 'vitest';
import {
  ACQUISITION_SOURCE_VALUES,
  CAMPAIGN_VALUES,
  acquisitionSourceFor,
  campaignFor,
  seedLeads,
} from '../domain/seed';
import {
  DIMENSIONS,
  UNASSIGNED,
  clusterChildren,
  createTimeframeDimension,
  type ClusterDimension,
} from './clusters';
import type { Lead } from '../domain/types';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const leads = seedLeads(4892, 0x5f3a21, NOW);

/**
 * A book with real agent attribution on some leads.
 *
 * `ingest` sets `ownerAgentId` from the `agentId` of the event that last touched
 * a lead, so this is what the book looks like after a session has been running —
 * a mixture of worked and unworked leads. Built deterministically rather than
 * randomly so the assertions below are stable.
 */
const AGENT_IDS = ['agent_call', 'agent_sms', 'agent_email', 'agent_booking'];
const warmed: readonly Lead[] = leads.map((lead, i) =>
  i % 3 === 0 ? { ...lead, ownerAgentId: AGENT_IDS[i % AGENT_IDS.length] } : lead,
);

/**
 * The partition invariant, as one reusable assertion.
 *
 * Aggregate-then-assert (D18): the obvious per-lead `expect` loop is ~5,000
 * assertions per dimension whose runtime is framework overhead, and it timed out
 * on a loaded machine once already.
 */
function expectPartitions(
  dim: ClusterDimension,
  book: readonly Lead[] = leads,
  minChildren = 2,
) {
  const buckets = new Map<string, number>();
  const missing: string[] = [];
  const multiple: string[] = [];

  for (const lead of book) {
    const key = dim.keyFor(lead);
    if (key === null) {
      missing.push(lead.id);
      continue;
    }
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    // Exactly one bucket: the lead must match its own key and no other.
    const alsoMatches = [...buckets.keys()].filter((k) => k !== key && dim.matches(lead, k));
    if (alsoMatches.length) multiple.push(`${lead.id}→${key}+${alsoMatches.join(',')}`);
  }

  expect(missing.slice(0, 5), `${dim.id}: leads with no key`).toEqual([]);
  expect(multiple.slice(0, 5), `${dim.id}: leads in more than one child`).toEqual([]);
  expect(buckets.size, `${dim.id}: needs children to be a drill`).toBeGreaterThanOrEqual(minChildren);

  const total = [...buckets.values()].reduce((a, b) => a + b, 0);
  expect(total, `${dim.id}: child counts must sum to the parent`).toBe(book.length);
  return buckets;
}

describe('campaign and acquisition source are deterministic', () => {
  it('derive from the lead id alone — same id, same value, always', () => {
    expect(campaignFor('lead_0000')).toBe(campaignFor('lead_0000'));
    expect(acquisitionSourceFor('lead_0042')).toBe(acquisitionSourceFor('lead_0042'));
  });

  it('are independent of the clock and of book size', () => {
    const small = seedLeads(50, 0x5f3a21, NOW);
    const large = seedLeads(4892, 0x5f3a21, NOW + 9_999_999);
    for (let i = 0; i < 50; i++) {
      expect(large[i].campaign).toBe(small[i].campaign);
      expect(large[i].acquisitionSource).toBe(small[i].acquisitionSource);
    }
  });

  it('match the pure functions, proving they are not drawn from the RNG stream', () => {
    // If these were taken from `rand()` they would depend on draw order, and this
    // equality would fail the moment anything else in the loop consumed a draw.
    for (const lead of leads.slice(0, 200)) {
      expect(lead.campaign).toBe(campaignFor(lead.id));
      expect(lead.acquisitionSource).toBe(acquisitionSourceFor(lead.id));
    }
  });

  it('leaves the pre-existing seeded book byte-identical', () => {
    // Pinned values. If a future change consumes a draw inside the seeding loop,
    // every one of these shifts — and every persisted event log silently starts
    // describing different leads. That is what this test is guarding.
    expect(leads[0].score).toBeCloseTo(0.7109584783073988, 12);
    expect(leads[1].score).toBeCloseTo(32.96903655296542, 12);
    expect(leads[2].score).toBeCloseTo(28.539911806650643, 12);
    expect(leads[0].segment).toBe('Dental + Vision');
    expect(leads[1].segment).toBe('Small Business');
  });

  it('only ever produce values from the declared tables', () => {
    const campaigns = new Set(leads.map((l) => l.campaign));
    const sources = new Set(leads.map((l) => l.acquisitionSource));
    for (const c of campaigns) expect(CAMPAIGN_VALUES).toContain(c);
    for (const s of sources) expect(ACQUISITION_SOURCE_VALUES).toContain(s);
  });
});

describe('distributions are weighted, not uniform, and not dominated', () => {
  const share = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.values()].map((n) => n / values.length).sort((a, b) => b - a);
  };

  it('campaign spreads across every category with a real skew', () => {
    const shares = share(leads.map((l) => l.campaign));
    expect(shares.length).toBe(CAMPAIGN_VALUES.length);
    expect(shares[0]).toBeLessThan(0.45); // nothing swallows the book
    expect(shares.at(-1)!).toBeGreaterThan(0.02); // nothing is a rounding error
    expect(shares[0] - shares.at(-1)!).toBeGreaterThan(0.05); // genuinely weighted
  });

  it('acquisition source spreads across every category with a real skew', () => {
    const shares = share(leads.map((l) => l.acquisitionSource));
    expect(shares.length).toBe(ACQUISITION_SOURCE_VALUES.length);
    expect(shares[0]).toBeLessThan(0.45);
    expect(shares.at(-1)!).toBeGreaterThan(0.02);
    expect(shares[0] - shares.at(-1)!).toBeGreaterThan(0.05);
  });

  it('campaign and source are independent — one does not predict the other', () => {
    // Shared salt would make them identical orderings; distinct salts must not.
    const pairs = new Set(leads.map((l) => `${l.campaign}|${l.acquisitionSource}`));
    expect(pairs.size).toBeGreaterThan(CAMPAIGN_VALUES.length);
  });
});

describe('every new dimension partitions its parent', () => {
  it('campaign', () => expectPartitions(DIMENSIONS.campaign));
  it('source', () => expectPartitions(DIMENSIONS.source));
  // Agent attribution comes from events, so a WARMED book is the realistic
  // case; the cold book is asserted separately below.
  it('agent (on an attributed book)', () => expectPartitions(DIMENSIONS.agent, warmed));
  it('timeframe', () => expectPartitions(createTimeframeDimension(() => NOW)));

  it('clusterChildren reports every member of the parent set', () => {
    // clusterChildren groups by DRILL_SEQUENCE, so this asserts the invariant it
    // actually relies on: the parent count it reports is the whole book.
    const { members } = clusterChildren(leads, []);
    expect(members).toBe(leads.length);
  });

  it('child keys are stable across repeated evaluation', () => {
    for (const dim of [DIMENSIONS.campaign, DIMENSIONS.source, DIMENSIONS.agent]) {
      const first = leads.slice(0, 500).map((l) => dim.keyFor(l));
      const second = leads.slice(0, 500).map((l) => dim.keyFor(l));
      expect(second).toEqual(first);
    }
  });
});

describe('agent attribution is honest about what it does not know', () => {
  it('a COLD book is one honest Unassigned cluster, not a fabricated spread', () => {
    // Nothing has worked these leads yet. `ownerAgentId` is set by `ingest` from
    // the agentId of the event that touched the lead, so inventing a seeded
    // assignment would be inventing data the product does not have. One truthful
    // cluster is the correct answer here — and it still partitions exactly.
    const buckets = expectPartitions(DIMENSIONS.agent, leads, 1);
    expect([...buckets.keys()]).toEqual([UNASSIGNED]);
    expect(buckets.get(UNASSIGNED)).toBe(leads.length);
    expect(DIMENSIONS.agent.labelFor(UNASSIGNED)).toBe('Unassigned');
  });

  it('a WARMED book splits by real attribution, keeping unworked leads visible', () => {
    const buckets = expectPartitions(DIMENSIONS.agent, warmed);
    expect(buckets.size).toBeGreaterThan(2);
    expect(buckets.get(UNASSIGNED)).toBeGreaterThan(0);
  });

  it('groups an attributed lead under its real agent, with a human label', () => {
    const owned: Lead = { ...leads[0], ownerAgentId: 'agent_call' };
    expect(DIMENSIONS.agent.keyFor(owned)).toBe('agent_call');
    expect(DIMENSIONS.agent.matches(owned, 'agent_call')).toBe(true);
    expect(DIMENSIONS.agent.matches(owned, UNASSIGNED)).toBe(false);
    expect(DIMENSIONS.agent.labelFor('agent_call')).toBe('Call Agent');
  });
});

describe('timeframe is deterministic for a supplied reference time', () => {
  const at = (now: number) => createTimeframeDimension(() => now);

  it('buckets by age, most recent first, mutually exclusive', () => {
    const dim = at(NOW);
    const make = (ageMs: number): Lead => ({ ...leads[0], lastEventAt: NOW - ageMs });
    expect(dim.keyFor(make(0))).toBe('today');
    expect(dim.keyFor(make(23 * 3600_000))).toBe('today');
    expect(dim.keyFor(make(2 * DAY))).toBe('3d');
    expect(dim.keyFor(make(5 * DAY))).toBe('7d');
    expect(dim.keyFor(make(20 * DAY))).toBe('30d');
    expect(dim.keyFor(make(400 * DAY))).toBe('older');
  });

  it('classifies a future timestamp rather than losing the lead to clock skew', () => {
    expect(at(NOW).keyFor({ ...leads[0], lastEventAt: NOW + DAY })).toBe('today');
  });

  it('does not depend on when the test runs — only on the reference time', () => {
    const lead = { ...leads[0], lastEventAt: NOW - 5 * DAY };
    expect(at(NOW).keyFor(lead)).toBe('7d');
    // Same lead, a fortnight later: a different bucket, and still deterministic.
    expect(at(NOW + 14 * DAY).keyFor(lead)).toBe('30d');
    expect(at(NOW + 14 * DAY).keyFor(lead)).toBe('30d');
  });

  it('labels every bucket and agrees with itself', () => {
    const dim = at(NOW);
    for (const lead of leads.slice(0, 1000)) {
      const key = dim.keyFor(lead)!;
      expect(dim.matches(lead, key)).toBe(true);
      expect(dim.labelFor(key)).not.toBe('');
    }
  });
});

describe('compatibility with shipped milestones', () => {
  it('the replay fixture still parses and targets real leads', async () => {
    const { demoSession } = await import('../state/fixtures/demoSession');
    const { parseSession } = await import('../state/replay');
    const session = demoSession(NOW);
    expect(() => parseSession(session)).not.toThrow();
    const ids = new Set(leads.map((l) => l.id));
    for (const { event } of session.events) expect(ids.has(event.leadId)).toBe(true);
  });

  it('a persisted log recorded before these fields still describes the same leads', async () => {
    // The book identity persistence records is {seed, leadCount}; neither
    // changed, and no pre-existing seeded value changed, so an old log replays
    // onto exactly the leads it was recorded against. No migration required.
    const { parsePersisted, PERSIST_FORMAT_VERSION } = await import('../state/persistence');
    const legacy = {
      version: PERSIST_FORMAT_VERSION,
      savedAt: NOW,
      book: { seed: 0x5f3a21, leadCount: 4892 },
      sealed: false,
      events: [
        { offsetMs: 0, event: { id: 'old_1', leadId: 'lead_0000', kind: 'contacted', at: NOW, agentId: null } },
      ],
    };
    const parsed = parsePersisted(legacy);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.book.leadCount).toBe(4892);
  });
});
