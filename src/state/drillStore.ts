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
import { DRILL_SEQUENCE, type PathStep } from '../universe/clusters';

interface DrillState {
  path: readonly PathStep[];
  /** Drill one level deeper. Ignored if already at full depth. */
  push: (step: PathStep) => void;
  /** Back out one level. */
  pop: () => void;
  /** Straight back to GLOBAL. */
  reset: () => void;
  /** Jump to a breadcrumb: keep the first `depth` steps. */
  toDepth: (depth: number) => void;
}

export const useDrill = create<DrillState>((set) => ({
  path: [],
  push: (step) =>
    set((s) =>
      s.path.length >= DRILL_SEQUENCE.length ? s : { path: [...s.path, step] },
    ),
  pop: () => set((s) => (s.path.length === 0 ? s : { path: s.path.slice(0, -1) })),
  reset: () => set((s) => (s.path.length === 0 ? s : { path: [] })),
  toDepth: (depth) =>
    set((s) => (depth >= s.path.length ? s : { path: s.path.slice(0, depth) })),
}));

/** Non-reactive read for frame loops — same pattern as `readLeads` et al. */
export const readDrillPath = (): readonly PathStep[] => useDrill.getState().path;
