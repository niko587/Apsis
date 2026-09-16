/**
 * DOM overlays for the Universe: the cluster breadcrumb (§15) and the Active
 * Skills panel (§12).
 *
 * These are real DOM, not canvas paint — which is what makes the drill-down
 * keyboard-reachable and screen-reader-visible. The canvas wrapper is
 * `aria-hidden` by design, so this component PORTALS its content out of the
 * wrapper and into the `.stage` element beside it. Everything here is buttons
 * and lists; nothing depends on the 3D layer being visible at all (§21).
 *
 * Both panels re-derive from the stores on a human cadence (task revision +
 * throttled revision), never at frame rate — text a person reads does not need
 * to update at 60Hz.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApsis } from '../state/store';
import { useThrottledRevision } from '../ui/useThrottledRevision';
import {
  DIMENSIONS,
  DRILL_SEQUENCE,
  clusterChildren,
  effectiveNextDimension,
  stepLabel,
  type PathStep,
} from './clusters';
import { useDrill } from '../state/drillStore';
import { deriveSkills } from './skills';
import './overlay.css';

/**
 * Every child cluster is rendered — the list scrolls rather than truncating.
 *
 * An earlier version showed twelve and appended "…and N more", which was fine
 * for nine Florida cities and wrong the moment the book went national: the
 * South alone spans seventeen states, so the states a user most likely wants
 * are frequently the ones past the cut. Hiding options behind a count is the
 * same mistake as the clipped rail — content that exists, is correct, and
 * cannot be reached.
 */

const DIM_LIST_ID = 'uv-dim-list';

function ClusterNav() {
  const path = useDrill((s) => s.path);
  const nextDimensionId = useDrill((s) => s.nextDimensionId);
  const chooseNextDimension = useDrill((s) => s.chooseNextDimension);
  const push = useDrill((s) => s.push);
  const pop = useDrill((s) => s.pop);
  const toDepth = useDrill((s) => s.toDepth);
  const select = useApsis((s) => s.select);
  const rev = useThrottledRevision(1000);

  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeDimRef = useRef<HTMLButtonElement>(null);
  /**
   * The Escape handler is installed once and must not be re-bound on every
   * open/close, so it reads the flag through a ref rather than closing over a
   * state value that would go stale inside the listener.
   */
  const pickerOpenRef = useRef(false);
  useEffect(() => {
    pickerOpenRef.current = pickerOpen;
  }, [pickerOpen]);

  /**
   * Navigating closes the picker — a grouping menu for a level you have left is
   * a menu about nothing.
   *
   * Done at the events that navigate rather than in an effect on `path`: an
   * effect would set state during a render caused by something else, which is a
   * cascading render and which the linter is right to flag. The picker can only
   * be open across a navigation if the user clicks a child chip or a breadcrumb
   * while it is showing, and both are right here.
   */
  const closePicker = () => setPickerOpen(false);

  // Opening puts focus on the current grouping, so the keyboard starts where
  // the eye does.
  useEffect(() => {
    if (pickerOpen) activeDimRef.current?.focus();
  }, [pickerOpen]);

  // Escape backs out: selection first (it is the deepest thing on screen),
  // then one drill level per press. Never steals Escape from a text field or
  // the lead listbox, which have their own Escape semantics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.getAttribute('role') === 'listbox'
      ) {
        return;
      }
      // Order: the picker is the shallowest thing on screen and closes first,
      // then the selection, then a drill level.
      if (pickerOpenRef.current) {
        pickerOpenRef.current = false;
        setPickerOpen(false);
        triggerRef.current?.focus();
        return;
      }
      const state = useApsis.getState();
      if (state.selectedLeadId) {
        state.select(null);
      } else if (useDrill.getState().path.length > 0) {
        setPickerOpen(false);
        pop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pop]);

  /**
   * ONE resolution, consumed by the heading, the picker and the child list
   * alike (D52). Deriving the dimension a second time anywhere below is how
   * they come to disagree about what they are showing.
   *
   * Throttled: this walks the book twice — once to decide which dimensions can
   * split the cluster, once to count the children of the winner — on the same
   * ~1s cadence that already drove `clusterChildren`. Never per frame.
   */
  const { dim, available, children, members } = useMemo(() => {
    void rev;
    const leads = useApsis.getState().leads;
    const resolved = effectiveNextDimension(leads.values(), path, nextDimensionId);
    const counted = clusterChildren(leads.values(), path, resolved.dimension);
    return { dim: resolved.dimension, available: resolved.available, ...counted };
  }, [path, nextDimensionId, rev]);

  // Consumed by the picker in the next step; resolved here so there is exactly
  // one availability computation.
  void available;

  return (
    <nav className="uv-clusters" aria-label="Cluster drill-down">
      <ol className="uv-crumbs">
        <li>
          {path.length === 0 ? (
            <span aria-current="location">GLOBAL</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                closePicker();
                toDepth(0);
              }}
            >
              GLOBAL
            </button>
          )}
        </li>
        {path.map((step, i) => {
          /**
           * Show the dimension only when this step DIVERGES from the default
           * for its depth. `West › Colorado › Colorado Springs` stays exactly
           * as it reads today; `Campaign · Open Enrollment` says what it is
           * precisely where the value alone would be ambiguous.
           *
           * The accessible name is unconditional — a screen-reader user never
           * has to infer the dimension from position.
           */
          const diverges = DRILL_SEQUENCE[i]?.id !== step.dimensionId;
          const dimLabel = DIMENSIONS[step.dimensionId]?.label ?? step.dimensionId;
          const value = stepLabel(step);
          const spoken = `${dimLabel}: ${value}`;
          const shown = diverges ? (
            <>
              <span className="uv-crumb-dim">{dimLabel}</span>
              {value}
            </>
          ) : (
            value
          );
          return (
            <li key={`${step.dimensionId}:${step.key}`}>
              {i === path.length - 1 ? (
                <span aria-current="location" aria-label={spoken}>
                  {shown}
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={spoken}
                  onClick={() => {
                    closePicker();
                    toDepth(i + 1);
                  }}
                >
                  {shown}
                </button>
              )}
            </li>
          );
        })}
      </ol>

      <p className="uv-members">
        {members.toLocaleString()} lead{members === 1 ? '' : 's'} in view
        {path.length > 0 && ' · rest of the book recedes, not removed'}
      </p>

      {dim ? (
        <>
          <h3>
            Drill into{' '}
            {available.length > 1 ? (
              <button
                type="button"
                ref={triggerRef}
                className="uv-dim-trigger"
                aria-expanded={pickerOpen}
                aria-controls={DIM_LIST_ID}
                // No alternatives count: announcing one would mean keeping the
                // availability analysis live purely to voice a number that
                // moves as the feed lands. The open list is the better answer.
                aria-label={`Group next by ${dim.label}`}
                onClick={() => setPickerOpen((open) => !open)}
              >
                {dim.label.toLowerCase()}
                <span aria-hidden="true" className="uv-dim-caret">
                  ▾
                </span>
              </button>
            ) : (
              dim.label.toLowerCase()
            )}
            <span className="uv-child-n">{children.length}</span>
          </h3>

          {pickerOpen && (
            <ul className="uv-dims" id={DIM_LIST_ID}>
              {available.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    ref={candidate.id === dim.id ? activeDimRef : undefined}
                    aria-current={candidate.id === dim.id ? 'true' : undefined}
                    onClick={() => {
                      // Changes what the NEXT step groups by. It does not
                      // navigate, does not push a PathStep, and does not move
                      // a single particle.
                      chooseNextDimension(candidate.id);
                      setPickerOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    {candidate.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ul className="uv-children">
            {children.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => {
                    closePicker();
                    const step: PathStep = { dimensionId: dim.id, key: c.key };
                    push(step);
                    // A new cluster invalidates a selection made outside it.
                    select(null);
                  }}
                >
                  {c.label}
                  <span className="uv-count">{c.count.toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : members === 0 ? (
        <p className="uv-hint">
          This cluster is empty right now. The book is live — ownership,
          recency and temperature all move — so a path can empty after you
          chose it. Back out to widen the view.
        </p>
      ) : (
        <p className="uv-hint">
          Deepest cluster — click a lead in the field, or pick one from the
          Leads list, to select it.
        </p>
      )}

      {path.length > 0 && (
        <button type="button" className="uv-back" onClick={pop}>
          ← Back <kbd>Esc</kbd>
        </button>
      )}
    </nav>
  );
}

function ActiveSkillsPanel() {
  // Re-render on task starts/completions immediately (that is when a skill
  // appears or changes phase) and on a throttled cadence for detail text.
  const taskRev = useApsis((s) => s.taskRevision);
  const rev = useThrottledRevision(750);
  const [, force] = useReducer((n: number) => n + 1, 0);

  const skills = useMemo(() => {
    void taskRev;
    void rev;
    const s = useApsis.getState();
    return deriveSkills(s.tasks, s.feed, s.leads, Date.now());
  }, [taskRev, rev]);

  // COMPLETE/ERROR entries expire by wall clock. If the feed goes quiet there
  // is no revision to re-render on, so schedule ONE re-read at the earliest
  // expiry. This timer only ever removes a display; it never creates state.
  useEffect(() => {
    const next = Math.min(...skills.map((s) => s.until));
    if (!Number.isFinite(next)) return;
    const id = window.setTimeout(force, Math.max(50, next - Date.now()));
    return () => window.clearTimeout(id);
  }, [skills]);

  const now = Date.now();
  const visible = skills.filter((s) => s.until > now);

  return (
    <section className="uv-skills" aria-label="Active skills">
      <h2>Active Skills</h2>
      {visible.length === 0 ? (
        <p className="uv-idle">No skills active</p>
      ) : (
        <ul>
          {visible.map((s) => (
            <li key={s.id} data-status={s.status}>
              <span className="uv-dot" style={{ background: s.color }} />
              <span className="uv-skill-name">{s.label}</span>
              <span className="uv-status">{s.status.toLowerCase()}</span>
              <span className="uv-detail">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Mounted by `Universe`, which lives inside the aria-hidden canvas wrapper —
 * so the actual DOM is portalled into `.stage`, the wrapper's parent, where
 * assistive tech and the tab order can reach it.
 */
export function UniverseOverlay() {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    setHost(document.querySelector('.stage') ?? document.body);
  }, []);
  if (!host) return null;
  return createPortal(
    <div className="uv-overlay">
      <ClusterNav />
      <ActiveSkillsPanel />
    </div>,
    host,
  );
}
