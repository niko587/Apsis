/**
 * Drill-down navigation state (§15).
 *
 * This is APPLICATION state, not 3D-layer state: the camera rig, the lead
 * field's dimming and the DOM breadcrumb all re-derive from it, exactly as they
 * do from the main store. So it lives here beside `store.ts` rather than in
 * `src/universe/` — the project's load-bearing invariant is that the 3D layer
 * owns NO state, and a zustand store sitting inside `src/universe/` makes that
 * claim false by inspection whatever the file actually does.
 *
 * `path` is immutable: every mutation replaces the array, so per-frame readers
 * can detect changes by reference identity — the same trick the lead field
 * already uses for the `matched` set.
 */

import { create } from 'zustand';
import { MAX_DRILL_DEPTH, type PathStep } from '../universe/clusters';

interface DrillState {
  path: readonly PathStep[];
  /**
   * What the user asked the NEXT level to group by, or null for the default.
   *
   * Navigation state, not history — `path` remains the record of what was
   * actually selected. It lives here rather than in the overlay because every
   * navigation must clear it (a dimension picked for depth 2 is meaningless at
   * depth 1) and `pop`/`toDepth` are store actions; component state would need
   * an effect watching `path`, which is the same value in two places with the
   * usual reward of a stale one after a breadcrumb jump.
   */
  nextDimensionId: string | null;
  /** Drill one level deeper. Ignored if already at full depth. */
  push: (step: PathStep) => void;
  /** Back out one level. */
  pop: () => void;
  /** Straight back to GLOBAL. */
  reset: () => void;
  /** Jump to a breadcrumb: keep the first `depth` steps. */
  toDepth: (depth: number) => void;
  /** Choose the next grouping. NEVER touches `path`. */
  chooseNextDimension: (id: string | null) => void;
}

export const useDrill = create<DrillState>((set) => ({
  path: [],
  nextDimensionId: null,
  push: (step) =>
    set((s) =>
      s.path.length >= MAX_DRILL_DEPTH
        ? s
        : { path: [...s.path, step], nextDimensionId: null },
    ),
  pop: () =>
    set((s) =>
      s.path.length === 0 ? s : { path: s.path.slice(0, -1), nextDimensionId: null },
    ),
  reset: () =>
    set((s) =>
      s.path.length === 0 && s.nextDimensionId === null
        ? s
        : { path: [], nextDimensionId: null },
    ),
  toDepth: (depth) =>
    set((s) =>
      depth >= s.path.length
        ? s
        : { path: s.path.slice(0, depth), nextDimensionId: null },
    ),
  chooseNextDimension: (id) =>
    set((s) => (s.nextDimensionId === id ? s : { nextDimensionId: id })),
}));

/** Non-reactive read for frame loops — same pattern as `readLeads` et al. */
export const readDrillPath = (): readonly PathStep[] => useDrill.getState().path;
