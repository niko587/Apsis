/**
 * Cluster / drill-down model (§15).
 *
 * Universe → geography → segment → individual lead, e.g.
 * GLOBAL → Florida → Tampa → Family Coverage → Sarah Martinez.
 *
 * A cluster is NOT a spatial regrouping. Score is the only thing that moves a
 * lead (§27 rule 3), so drilling in cannot herd the members into a huddle —
 * instead the drilled set stays lit at full luminance while everything outside
 * it recedes to the same 0.13 dim the command bar uses for non-matches, and the
 * camera performs the framing move. The shape of the whole book stays legible;
 * the cluster is the part of it that is still bright.
 *
 * Dimensions are deliberately open: §15 lists geography, lead type, campaign,
 * temperature, source, agent, intent and timeframe as candidate groupings.
 * Adding one is a `ClusterDimension` entry plus (optionally) a slot in
 * `DRILL_SEQUENCE`; nothing else changes. `temperature` below exists precisely
 * to prove the registry is not shaped around geography.
 *
 * Pure module — no React, no three.js — so it is testable the same way the
 * domain is. `matches` is allocation-free because the lead field calls it for
 * every lead inside its revision-gated recompute.
 */

import { STAGES, type Lead, type Stage } from '../domain/types';
import { STATE_NAMES, STATE_REGION, cityOf, stateOf } from '../domain/geography';
import { seedAgents } from '../domain/seed';

/** Agent id → human label, built once. Unknown ids fall back to the id itself. */
const AGENT_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  seedAgents().map((a) => [a.id, a.label]),
);

/** The bucket a lead with no agent attribution lands in. Never dropped. */
export const UNASSIGNED = 'unassigned';

/**
 * Timeframe buckets, most recent first.
 *
 * `maxAgeMs` is an upper bound on age; the first bucket a lead fits wins, so the
 * buckets are mutually exclusive by construction and `older` catches everything
 * else. That is what makes the partition total — there is no lead this cannot
 * classify, including one whose `lastEventAt` is in the future (clock skew), which
 * lands in `today` rather than nowhere.
 */
const DAY_MS = 86_400_000;
const TIMEFRAME_BUCKETS: ReadonlyArray<{ key: string; label: string; maxAgeMs: number }> = [
  { key: 'today', label: 'Today', maxAgeMs: DAY_MS },
  { key: '3d', label: 'Last 3 days', maxAgeMs: 3 * DAY_MS },
  { key: '7d', label: 'Last 7 days', maxAgeMs: 7 * DAY_MS },
  { key: '30d', label: 'Last 30 days', maxAgeMs: 30 * DAY_MS },
  { key: 'older', label: 'Older', maxAgeMs: Number.POSITIVE_INFINITY },
];

const timeframeKeyAt = (lead: Lead, now: number): string => {
  const age = now - lead.lastEventAt;
  for (const bucket of TIMEFRAME_BUCKETS) if (age < bucket.maxAgeMs) return bucket.key;
  return 'older';
};

/**
 * Timeframe is the one dimension that depends on *when you ask*.
 *
 * `ClusterDimension.keyFor` takes no clock, so the reference time is captured by
 * the factory. Production registers it with `Date.now`; tests build one with a
 * fixed clock, which is the only way a bucket assertion can be deterministic
 * rather than a function of when the suite happened to run.
 */
export function createTimeframeDimension(now: () => number = Date.now): ClusterDimension {
  return {
    id: 'timeframe',
    label: 'Timeframe',
    keyFor: (lead) => timeframeKeyAt(lead, now()),
    labelFor: (key) => TIMEFRAME_BUCKETS.find((b) => b.key === key)?.label ?? key,
    matches: (lead, key) => timeframeKeyAt(lead, now()) === key,
  };
}

export interface ClusterDimension {
  readonly id: string;
  /** Human name of the grouping, e.g. "City". */
  readonly label: string;
  /** Grouping key for a lead, or null if the lead has no value here. */
  keyFor(lead: Lead): string | null;
  /** Display label for a key, e.g. "FL" → "Florida". */
  labelFor(key: string): string;
  /** Allocation-free membership test. Must agree with `keyFor`. */
  matches(lead: Lead, key: string): boolean;
}

export const DIMENSIONS: Readonly<Record<string, ClusterDimension>> = {
  /**
   * Census region. It exists so the first drill level has four legible choices
   * rather than the forty-four states the book actually spans — twelve chips is
   * a glance, forty-four is a search.
   */
  region: {
    id: 'region',
    label: 'Region',
    keyFor: (lead) => STATE_REGION[stateOf(lead.location)] ?? null,
    labelFor: (key) => key,
    matches: (lead, key) => STATE_REGION[stateOf(lead.location)] === key,
  },
  state: {
    id: 'state',
    label: 'State',
    keyFor: (lead) => stateOf(lead.location),
    labelFor: (key) => STATE_NAMES[key] ?? key,
    // `endsWith(key)` rather than `=== stateOf(...)`: same answer, no slice
    // allocation, and this runs once per lead inside the field's recompute.
    matches: (lead, key) => lead.location.endsWith(key),
  },
  city: {
    id: 'city',
    label: 'City',
    // The full "Tampa, FL" string is the key — comparing it is a single `===`
    // with no substring allocation, and it keeps Charleston SC and Charleston
    // WV as the two distinct clusters they are.
    keyFor: (lead) => lead.location,
    labelFor: cityOf,
    matches: (lead, key) => lead.location === key,
  },
  segment: {
    id: 'segment',
    label: 'Segment',
    keyFor: (lead) => lead.segment,
    labelFor: (key) => key,
    matches: (lead, key) => lead.segment === key,
  },
  /**
   * Marketing campaign that produced the lead. A different axis from `segment`:
   * "Open Enrollment" is a season, "Medicare" is a product.
   */
  campaign: {
    id: 'campaign',
    label: 'Campaign',
    keyFor: (lead) => lead.campaign,
    labelFor: (key) => key,
    matches: (lead, key) => lead.campaign === key,
  },
  /**
   * How the lead was acquired. Note the field is `acquisitionSource`, never
   * `source` — `LeadSource` is the runtime transport and has nothing to do with
   * this.
   */
  source: {
    id: 'source',
    label: 'Source',
    keyFor: (lead) => lead.acquisitionSource,
    labelFor: (key) => key,
    matches: (lead, key) => lead.acquisitionSource === key,
  },
  /**
   * Owning agent.
   *
   * The source of truth is `lead.ownerAgentId`, which `ingest` sets from the
   * `agentId` of the event that last touched the lead — so this reflects real
   * attribution rather than a fabricated assignment field. A seeded lead nothing
   * has worked yet has no owner, and is reported as Unassigned rather than
   * quietly dropped: on the default book that is most of them, and a dimension
   * that silently omitted the majority would be worse than no dimension.
   */
  agent: {
    id: 'agent',
    label: 'Agent',
    keyFor: (lead) => lead.ownerAgentId ?? UNASSIGNED,
    labelFor: (key) => (key === UNASSIGNED ? 'Unassigned' : (AGENT_LABELS[key] ?? key)),
    matches: (lead, key) => (lead.ownerAgentId ?? UNASSIGNED) === key,
  },
  /** Recency of the last real event on the lead. See `createTimeframeDimension`. */
  timeframe: createTimeframeDimension(),
  /** Not in the default drill order — here to keep the registry honest about
   *  being open to the other §15 groupings. */
  temperature: {
    id: 'temperature',
    label: 'Temperature',
    keyFor: (lead) => lead.stage,
    labelFor: (key) => STAGES[key as Stage]?.label ?? key,
    matches: (lead, key) => lead.stage === key,
  },
};

/**
 * The drill order: Universe → region → state → city → segment → individual.
 * The final "individual" level is selection, which already exists in the store —
 * at full depth clicking a lead (field or list) is the last step of the path.
 *
 * Region leads because the book is national. Each level has to partition the
 * one above it into something scannable, and going straight to states would put
 * forty-four chips on the first screen.
 */
export const DRILL_SEQUENCE: readonly ClusterDimension[] = [
  DIMENSIONS.region,
  DIMENSIONS.state,
  DIMENSIONS.city,
  DIMENSIONS.segment,
];

export interface PathStep {
  readonly dimensionId: string;
  readonly key: string;
}

export const stepLabel = (step: PathStep): string =>
  DIMENSIONS[step.dimensionId]?.labelFor(step.key) ?? step.key;

/**
 * How deep the analytical drill goes before the next step is an individual lead.
 *
 * DELIBERATELY NOT `DRILL_SEQUENCE.length` (D50). They are both four today, and
 * that is a coincidence of the current default suggestions — not a definition.
 * Tying focus depth to the length of a convenience list would mean that adding
 * a fifth default grouping silently changed when §14 spatial focus engages.
 */
export const MAX_DRILL_DEPTH = 4;

/** Registry order, fixed once. Availability and resolution both read it. */
const DIMENSION_IDS: readonly string[] = Object.keys(DIMENSIONS);

/**
 * Which dimensions can actually split the current cluster (D49).
 *
 * ONE rule — "does this produce two or more children?" — and every case falls
 * out of it. A dimension already in the path leaves every member sharing its
 * key, so it yields one child. `region` after `state` is already determined, so
 * it yields one child. A dimension where every member happens to share a value
 * yields one child. None of those need a compatibility table, a "used" set, or
 * a geography special case, and none is present here.
 *
 * EXACTLY ONE TRAVERSAL OF `leads` (D53). Production calls this with
 * `leads.values()`, which is a single-pass Map iterator, so the obvious
 * `for (dimension) for (lead)` shape would let only the first dimension see the
 * book and silently report every other one as unavailable — a picker that only
 * ever offers `region`, with nothing in the code looking wrong. So the loop is
 * inverted: one pass over the leads, every candidate advanced together.
 *
 * O(members × dimensions), and at most two retained keys per dimension: once a
 * dimension has seen two distinct keys it is proven, and its key set is dropped.
 */
export function availableDimensions(
  leads: Iterable<Lead>,
  path: readonly PathStep[],
): ClusterDimension[] {
  const pending = new Map<string, Set<string>>();
  const proven = new Set<string>();
  for (const id of DIMENSION_IDS) pending.set(id, new Set());

  for (const lead of leads) {
    if (!matchesPath(lead, path)) continue;
    if (pending.size === 0) continue; // everything proven; finish the pass cheaply
    for (const [id, keys] of pending) {
      const key = DIMENSIONS[id]!.keyFor(lead);
      if (key === null || keys.has(key)) continue;
      keys.add(key);
      if (keys.size >= 2) {
        proven.add(id);
        pending.delete(id); // no more key storage for this dimension
      }
    }
  }

  // Registry order, so the picker is stable between renders.
  return DIMENSION_IDS.filter((id) => proven.has(id)).map((id) => DIMENSIONS[id]!);
}

export interface NextDimensionResolution {
  /** What the next drill groups by, or null when the path is terminal/unsplittable. */
  readonly dimension: ClusterDimension | null;
  /** The availability list the resolution used. Handed on so nobody recomputes it. */
  readonly available: ClusterDimension[];
}

/**
 * THE single decision about what the next grouping is (D52).
 *
 * The heading, the picker's active state and `clusterChildren` all consume this
 * one result. An earlier design resolved a null selection straight to
 * `DRILL_SEQUENCE[path.length]`, which breaks in two ordinary cases:
 *
 *   - `Agent → Timeframe → Segment` leaves a depth whose raw default is
 *     `segment`, already used, so it yields one child;
 *   - `City` at depth 0 leaves a depth whose raw default is `state`, already
 *     determined by the city, so it yields one child.
 *
 * Both would have violated D49 while the heading cheerfully announced the
 * dimension. So resolution may step PAST a default that cannot split.
 *
 * Resolving the next grouping is not rewriting history: `path` is never touched,
 * and a selection that has stopped being available is superseded for this level
 * rather than deleted — the next navigation clears it anyway.
 */
export function effectiveNextDimension(
  leads: Iterable<Lead>,
  path: readonly PathStep[],
  selectedId: string | null = null,
): NextDimensionResolution {
  if (path.length >= MAX_DRILL_DEPTH) return { dimension: null, available: [] };

  const available = availableDimensions(leads, path);
  if (available.length === 0) return { dimension: null, available };

  const selected = selectedId
    ? available.find((d) => d.id === selectedId)
    : undefined;
  if (selected) return { dimension: selected, available };

  const fallbackId = DRILL_SEQUENCE[path.length]?.id;
  const byDefault = fallbackId
    ? available.find((d) => d.id === fallbackId)
    : undefined;
  if (byDefault) return { dimension: byDefault, available };

  // Stable registry order — never child count, which would reshuffle the menu
  // as the feed lands.
  return { dimension: available[0]!, available };
}

/** Allocation-free: is this lead inside the drilled cluster? */
export function matchesPath(lead: Lead, path: readonly PathStep[]): boolean {
  for (let i = 0; i < path.length; i++) {
    const dim = DIMENSIONS[path[i].dimensionId];
    if (!dim || !dim.matches(lead, path[i].key)) return false;
  }
  return true;
}

export interface ClusterChild {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

/**
 * The next-level clusters under the current path, largest first.
 * Runs in DOM land on a throttled cadence, never per frame.
 */
export function clusterChildren(
  leads: Iterable<Lead>,
  path: readonly PathStep[],
  /**
   * The resolved grouping, from `effectiveNextDimension`. Passed in rather than
   * re-derived: a second derivation is how the heading and the child list come
   * to disagree about what they are showing (D52).
   */
  dim: ClusterDimension | null,
): { children: ClusterChild[]; members: number } {
  const counts = new Map<string, number>();
  let members = 0;
  for (const lead of leads) {
    if (!matchesPath(lead, path)) continue;
    members++;
    if (!dim) continue;
    const key = dim.keyFor(lead);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const children = [...counts.entries()]
    .map(([key, count]) => ({ key, label: dim!.labelFor(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { children, members };
}
