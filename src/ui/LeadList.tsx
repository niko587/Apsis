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
import { useThrottledRevision } from './useThrottledRevision';
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
  const select = useApsis((s) => s.select);
  const hover = useApsis((s) => s.hover);

  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Warmest first: the list reads inward, the same direction the field does.
  //
  // Selects the top N in a single pass rather than sorting the whole book. Only
  // 150 rows are ever shown, so a full sort spends O(n log n) to throw away
  // 99.75% of its own output — at 60,000 leads that was ~1M comparisons every
  // refresh. Here a lead is only inserted if it beats the current cut-off, which
  // almost none do once the window is full, so the pass is O(n) in practice.
  const { rows, total } = useMemo(() => {
    const filtering = matched.size > 0;
    const top: Lead[] = [];
    let count = 0;
    let cutoff = -Infinity;

    for (const lead of leads.values()) {
      if (filtering && !matched.has(lead.id)) continue;
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
    return { rows: top, total: count };
    // `revision` forces a recompute as scores change; the Map identity is stable.
  }, [leads, matched, revision]);

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

  return (
    <section className="panel grow">
      <h2 id="leadlist-label">
        Leads
        <span className="h2-aside">
          {matched.size > 0 ? `${total.toLocaleString()} matched` : `${total.toLocaleString()} total`}
        </span>
      </h2>

      <p className="sr-only" id="leadlist-help">
        Arrow keys move through leads, Enter pins the focused lead, Escape clears
        the selection. Leads are ordered by how close they are to a booked
        appointment.
      </p>

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
