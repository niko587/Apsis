/**
 * The keyboard- and screen-reader-accessible view of the Lead Universe.
 *
 * §21 asks that the 3D enhance the experience rather than make the application
 * unusable. The honest way to meet that is not to bolt ARIA onto a canvas — a
 * canvas has no structure to expose — but to publish the same information as
 * real DOM that can be tabbed, arrowed and read aloud.
 *
 * So this is not a sidebar that happens to list leads. It is the Universe, in
 * text: same source of truth, same ordering by approach to periapsis, same
 * selection. Selecting here moves the marker in the 3D field, and selecting
 * there moves the cursor here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApsis } from '../state/store';
import { useDrill } from '../state/drillStore';
import { useThrottledRevision } from './useThrottledRevision';
import { DIMENSIONS, matchesPath } from '../universe/clusters';
import { STAGES, type Lead } from '../domain/types';

/**
 * Rows rendered at once.
 *
 * §20 asks large lists to be virtualised. Rather than add a windowing
 * dependency for a panel this size, the list shows the leads nearest periapsis
 * and states plainly how many it is not showing — a silent top-N would read as
 * "this is the whole book" when it is 4% of it.
 */
const VISIBLE_CAP = 150;

export function LeadList() {
  const leads = useApsis((s) => s.leads);
  const matched = useApsis((s) => s.matched);
  // Throttled: keying off the raw revision rebuilds this on every ingested
  // event, which is ~9 times a second. See useThrottledRevision.
  const revision = useThrottledRevision();
  const selectedId = useApsis((s) => s.selectedLeadId);
  const hoveredId = useApsis((s) => s.hoveredLeadId);
  const select = useApsis((s) => s.select);
  const hover = useApsis((s) => s.hover);
  /**
   * The drilled cluster.
   *
   * THE DEFECT THIS FIXES: this list used to filter on `matched` alone, so
   * drilling dimmed the field and moved the camera while the roster kept
   * showing the same global top-150 by score. At 4,892 leads that is 3% of the
   * book, so a mid-scoring lead inside a deep cluster appeared in the roster at
   * NO depth and could only be found by clicking particles.
   *
   * Measured on the default book, a full-depth cluster holds a median of 5
   * members and never more than 81 across all 570 of them — so once the roster
   * respects the path, `VISIBLE_CAP` can never truncate one and every member of
   * a segment is listed, always.
   */
  const path = useDrill((s) => s.path);

  const [cursor, setCursor] = useState(0);
  /**
   * Find-within-cluster. LOCAL view state on purpose: it is not domain data, it
   * never reaches the event log, and it must not survive a change of cluster —
   * a filter left over from somewhere else is a lie about what is on screen.
   */
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Path identity is stable per drill step (the store replaces the array), so
  // this fires exactly once per navigation.
  useEffect(() => {
    setSearch('');
  }, [path]);

  /**
   * Bring the roster into view when the user drills deeper.
   *
   * Found by looking at the screen rather than at the tests: with the roster
   * made drill-aware, every assertion passed while the panel itself sat 145px
   * below the rail's fold at 1600x1000 (345px at 1280x800). The list held
   * exactly the four leads the user wanted and they could not see it — the
   * D12 lesson in a new costume, and the tests could not catch it because
   * Playwright locators do not care about scroll position.
   *
   * `block: 'start'`, NOT `'nearest'`. `'nearest'` scrolls the minimum, which
   * parks the panel's top edge at the bottom of the rail: the heading is
   * technically on screen while every row sits at or below the fold, and a real
   * click lands outside the viewport entirely. Aligning the panel to the top of
   * the rail is what makes its ROWS usable — visible has to mean operable.
   *
   * Only on a DEEPER path, and only when it is actually out of view. Backing
   * out does not scroll: the user is heading up and out, not toward the list.
   */
  const lastDepth = useRef(path.length);
  useEffect(() => {
    const deeper = path.length > lastDepth.current;
    lastDepth.current = path.length;
    if (!deeper) return;
    const panel = panelRef.current;
    const rail = panel?.parentElement;
    if (!panel || !rail) return;
    const p = panel.getBoundingClientRect();
    const r = rail.getBoundingClientRect();
    // NOT "is any of it visible". The panel routinely straddles the fold — its
    // heading on screen, every row below it — and an overlap test calls that
    // visible and skips the scroll, which is exactly the state that made a real
    // click miss the first row. Scroll whenever it is not ENTIRELY in view.
    if (p.top < r.top || p.bottom > r.bottom) {
      panel.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [path]);

  // Warmest first: the list reads inward, the same direction the field does.
  //
  // Selects the top N in a single pass rather than sorting the whole book. Only
  // 150 rows are ever shown, so a full sort spends O(n log n) to throw away
  // 99.75% of its own output — at 60,000 leads that was ~1M comparisons every
  // refresh. Here a lead is only inserted if it beats the current cut-off, which
  // almost none do once the window is full, so the pass is O(n) in practice.
  const { rows, total, clusterTotal } = useMemo(() => {
    const filtering = matched.size > 0;
    const drilled = path.length > 0;
    const needle = search.trim().toLowerCase();
    const top: Lead[] = [];
    let count = 0;
    /** Members of the drilled cluster before the search narrows them. */
    let inCluster = 0;
    let cutoff = -Infinity;

    for (const lead of leads.values()) {
      // Membership comes from `matchesPath` and nowhere else — the same
      // predicate the field dims with and the camera frames with. A second
      // implementation of "is this lead in the cluster" would eventually
      // disagree with the picture on screen.
      if (drilled && !matchesPath(lead, path)) continue;
      // Drill and command-bar results COMPOSE: a lead must clear both.
      if (filtering && !matched.has(lead.id)) continue;
      inCluster++;
      if (needle && !lead.name.toLowerCase().includes(needle)) continue;
      count++;

      if (top.length < VISIBLE_CAP) {
        top.push(lead);
        if (top.length === VISIBLE_CAP) {
          top.sort((a, b) => b.score - a.score);
          cutoff = top[VISIBLE_CAP - 1].score;
        }
        continue;
      }
      if (lead.score <= cutoff) continue;

      // Beats the cut-off: binary-insert and drop the coldest.
      let lo = 0;
      let hi = top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (top[mid].score > lead.score) lo = mid + 1;
        else hi = mid;
      }
      top.splice(lo, 0, lead);
      top.pop();
      cutoff = top[VISIBLE_CAP - 1].score;
    }

    // Fewer than the cap: never sorted in the loop above.
    if (top.length < VISIBLE_CAP) top.sort((a, b) => b.score - a.score);
    return { rows: top, total: count, clusterTotal: inCluster };
    // `revision` forces a recompute as scores change; the Map identity is stable.
  }, [leads, matched, revision, path, search]);

  // Keep the cursor in range when the underlying set shrinks.
  useEffect(() => {
    if (cursor > rows.length - 1) setCursor(Math.max(0, rows.length - 1));
  }, [rows.length, cursor]);

  const move = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(rows.length - 1, cursor + delta));
      if (next === cursor) return;

      // Side effects live OUTSIDE the state updater.
      //
      // The updater used to call `hover()` — another store's setState — and
      // `scrollIntoView` inline. A state updater must be pure: React is free to
      // invoke it more than once (it does under StrictMode), which fired both
      // effects twice, and any path where it runs during render turns the
      // `hover()` call into a cross-component update during render.
      setCursor(next);

      const lead = rows[next];
      if (lead) hover(lead.id);
      listRef.current
        ?.querySelector(`[data-idx="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    },
    [rows, hover, cursor],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'PageDown': e.preventDefault(); move(10); break;
      case 'PageUp': e.preventDefault(); move(-10); break;
      case 'Home': e.preventDefault(); move(-rows.length); break;
      case 'End': e.preventDefault(); move(rows.length); break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const lead = rows[cursor];
        if (lead) select(selectedId === lead.id ? null : lead.id);
        break;
      }
      case 'Escape': select(null); break;
    }
  };

  const active = rows[cursor];

  /**
   * What the header says, and it must never overstate the list.
   *
   * A truncated roster that looks complete is the D12 failure wearing different
   * clothes: the user believes they are seeing the cluster when they are seeing
   * the top of it. So the count states the cluster size, and says "showing X of
   * Y" whenever the cap actually bit.
   */
  const deepest = path.length > 0 ? path[path.length - 1] : null;
  const clusterLabel = deepest
    ? (DIMENSIONS[deepest.dimensionId]?.labelFor(deepest.key) ?? deepest.key)
    : null;
  const searching = search.trim().length > 0;
  const capped = rows.length < total;
  const commandFiltered = matched.size > 0;
  const countLabel = capped
    ? `showing ${rows.length} of ${total.toLocaleString()} · narrow the drill or search`
    : searching
      ? `${total.toLocaleString()} of ${clusterTotal.toLocaleString()} match`
      : deepest && commandFiltered
        // Both a drill and a command result are narrowing this list. Saying only
        // "in cluster" would let the user read it as the whole cluster.
        ? `${total.toLocaleString()} in cluster · command filtered`
        : deepest
          ? `${total.toLocaleString()} in cluster`
          : commandFiltered
            ? `${total.toLocaleString()} matched`
            : `${total.toLocaleString()} total`;

  return (
    <section className="panel grow" ref={panelRef}>
      <h2 id="leadlist-label">
        {clusterLabel ? `Leads · ${clusterLabel}` : 'Leads'}
        <span className="h2-aside">{countLabel}</span>
      </h2>

      {/* Find-within-cluster. Appears once a drill exists, because at GLOBAL the
          command bar is the right tool and two search affordances side by side
          would be a question rather than an answer. */}
      {path.length > 0 && (
        <input
          ref={searchRef}
          className="leadsearch"
          type="search"
          value={search}
          placeholder={`Find in ${clusterLabel ?? 'cluster'}…`}
          aria-label={`Find a lead in ${clusterLabel ?? 'the current cluster'}`}
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            // Down arrow hands over to the listbox, so the whole path —
            // drill, type, arrow, Enter — works without a pointer.
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor(0);
              listRef.current?.focus();
            } else if (e.key === 'Escape') {
              // Clears the filter and stops here: Escape must not also unwind
              // the drill while the user is mid-search.
              e.preventDefault();
              e.stopPropagation();
              setSearch('');
            }
          }}
        />
      )}

      <p className="sr-only" id="leadlist-help">
        Arrow keys move through leads, Enter pins the focused lead, Escape clears
        the selection. Leads are ordered by how close they are to a booked
        appointment.
      </p>

      {rows.length === 0 && (
        <p className="muted">
          {search.trim()
            ? `No leads match “${search.trim()}” in this cluster.`
            : 'No leads in this cluster.'}
        </p>
      )}

      <ul
        ref={listRef}
        className="leadlist"
        role="listbox"
        tabIndex={0}
        aria-labelledby="leadlist-label"
        aria-describedby="leadlist-help"
        aria-activedescendant={active ? `lead-opt-${active.id}` : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => hover(null)}
        // Mirrors the field's `onPointerOut`. Rows set hover on enter; without
        // this the last row hovered stays lit in the field after the pointer has
        // moved on, pointing at a lead the user is no longer indicating. It was
        // invisible before the hover ring existed.
        onMouseLeave={() => hover(null)}
      >
        {rows.map((lead, i) => {
          const spec = STAGES[lead.stage];
          return (
            <li
              key={lead.id}
              id={`lead-opt-${lead.id}`}
              data-idx={i}
              role="option"
              aria-selected={selectedId === lead.id}
              className={[
                i === cursor ? 'cursor' : '',
                selectedId === lead.id ? 'picked' : '',
                // Field → list half of the hover loop: pointing at a particle
                // marks its row. Deliberately NOT scrolled into view — a list
                // that moves under a travelling cursor is unusable.
                hoveredId === lead.id && selectedId !== lead.id ? 'hovered' : '',
              ].join(' ')}
              onClick={() => {
                setCursor(i);
                select(lead.id);
              }}
              onMouseEnter={() => hover(lead.id)}
            >
              <span className="dot" style={{ background: spec.color }} aria-hidden="true" />
              <span className="ll-name">{lead.name}</span>
              <span className="ll-stage">{spec.label}</span>
              <span className="ll-score">{Math.round(lead.score)}</span>
              {/* The visible row is terse; the accessible name is complete. */}
              <span className="sr-only">
                {`${spec.label}, score ${Math.round(lead.score)}, ${lead.segment}, ${lead.location}`}
              </span>
            </li>
          );
        })}
        {rows.length === 0 && <li className="muted">No leads match.</li>}
      </ul>

      {total > rows.length && (
        <p className="ll-more">
          Showing the {rows.length} closest to periapsis of {total.toLocaleString()}.
        </p>
      )}
    </section>
  );
}
