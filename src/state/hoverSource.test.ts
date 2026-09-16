/**
 * Hover provenance (D25).
 *
 * `hoveredLeadId` alone was not enough information. The Lead detail panel grows
 * from a placeholder to a full record the moment it has a lead to show, and it
 * sits above the Leads list in the rail — so previewing a lead hovered IN THAT
 * LIST pushed the very row under the pointer ~310px down, and the click that
 * followed missed it. Where it came from is therefore part of what a hover is,
 * and these tests pin that rather than leaving it to a comment.
 *
 * The rendering consequence is asserted in the browser
 * (`reachability.spec.ts` → "pointing at a lead row does not move it"), because
 * a layout shift is not a thing jsdom can see. This file pins the state machine
 * underneath it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useApsis } from './store';

const read = () => {
  const s = useApsis.getState();
  return { id: s.hoveredLeadId, source: s.hoverSource };
};

describe('hover source', () => {
  beforeEach(() => {
    useApsis.getState().hover(null);
  });

  it('defaults to the field, so the 3D layer needs no ceremony', () => {
    useApsis.getState().hover('lead_1');
    expect(read()).toEqual({ id: 'lead_1', source: 'field' });
  });

  it('records a list hover as such', () => {
    useApsis.getState().hover('lead_1', 'list');
    expect(read()).toEqual({ id: 'lead_1', source: 'list' });
  });

  it('clears the source with the hover — a stale source outlives its meaning', () => {
    useApsis.getState().hover('lead_1', 'list');
    useApsis.getState().hover(null);
    expect(read()).toEqual({ id: null, source: null });
  });

  it('re-hovering the SAME lead from a different surface updates the source', () => {
    // The bug this forbids: the field and the list both point at one lead, the
    // id does not change, the early-out fires, and the detail panel keeps
    // previewing from a list hover — reflowing the rail under the pointer.
    useApsis.getState().hover('lead_1', 'field');
    useApsis.getState().hover('lead_1', 'list');
    expect(read()).toEqual({ id: 'lead_1', source: 'list' });

    useApsis.getState().hover('lead_1', 'field');
    expect(read()).toEqual({ id: 'lead_1', source: 'field' });
  });

  it('is still referentially stable when nothing actually changed', () => {
    useApsis.getState().hover('lead_1', 'list');
    const before = useApsis.getState();
    useApsis.getState().hover('lead_1', 'list');
    // Identity, not equality: this early-out is what keeps a pointer travelling
    // across one lead from re-rendering the rail every mousemove.
    expect(useApsis.getState()).toBe(before);
  });
});
