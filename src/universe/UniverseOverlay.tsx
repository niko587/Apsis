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

import { useEffect, useMemo, useReducer, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApsis } from '../state/store';
import { useThrottledRevision } from '../ui/useThrottledRevision';
import {
  clusterChildren,
  nextDimension,
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

function ClusterNav() {
  const path = useDrill((s) => s.path);
  const push = useDrill((s) => s.push);
  const pop = useDrill((s) => s.pop);
  const toDepth = useDrill((s) => s.toDepth);
  const select = useApsis((s) => s.select);
  const rev = useThrottledRevision(1000);

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
      const state = useApsis.getState();
      if (state.selectedLeadId) {
        state.select(null);
      } else if (useDrill.getState().path.length > 0) {
        pop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pop]);

  // Child clusters under the current path. Throttled — this walks the book.
  const { children, members } = useMemo(() => {
    void rev;
    return clusterChildren(useApsis.getState().leads.values(), path);
  }, [path, rev]);

  const dim = nextDimension(path);

  return (
    <nav className="uv-clusters" aria-label="Cluster drill-down">
      <ol className="uv-crumbs">
        <li>
          {path.length === 0 ? (
            <span aria-current="location">GLOBAL</span>
          ) : (
            <button type="button" onClick={() => toDepth(0)}>
              GLOBAL
            </button>
          )}
        </li>
        {path.map((step, i) => (
          <li key={`${step.dimensionId}:${step.key}`}>
            {i === path.length - 1 ? (
              <span aria-current="location">{stepLabel(step)}</span>
            ) : (
              <button type="button" onClick={() => toDepth(i + 1)}>
                {stepLabel(step)}
              </button>
            )}
          </li>
        ))}
      </ol>

      <p className="uv-members">
        {members.toLocaleString()} lead{members === 1 ? '' : 's'} in view
        {path.length > 0 && ' · rest of the book recedes, not removed'}
      </p>

      {dim ? (
        <>
          <h3>
            Drill into {dim.label.toLowerCase()}
            <span className="uv-child-n">{children.length}</span>
          </h3>
          <ul className="uv-children">
            {children.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => {
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
