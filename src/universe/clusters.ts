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

/** The dimension the NEXT drill would group by, or null at full depth. */
export const nextDimension = (path: readonly PathStep[]): ClusterDimension | null =>
  DRILL_SEQUENCE[path.length] ?? null;

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
): { children: ClusterChild[]; members: number } {
  const dim = nextDimension(path);
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
