/**
 * The Apsis shell.
 *
 * Every number on screen is read from the same store the Universe renders from,
 * so the HUD and the field can never disagree.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Universe } from './universe/Universe';
import { useApsis } from './state/store';
import { createConfiguredSource } from './state/sources';
import { bootSession, refreshPersistenceStatus } from './state/boot';
import type { PersistenceController } from './state/persistence';
import { STAGES, STAGE_ORDER, bandLabel } from './domain/types';
import { LeadDetail } from './ui/LeadDetail';
import { AgentRoster } from './ui/AgentRoster';
import { CommandBar } from './ui/CommandBar';
import { LeadList } from './ui/LeadList';
import { StatusAnnouncer, SelectionAnnouncer } from './ui/StatusAnnouncer';
import { Orchestrator } from './ui/Orchestrator';
import { AppointmentCentre } from './ui/AppointmentCentre';
import { SystemState } from './ui/SystemState';
import { UniverseBoundary } from './ui/UniverseBoundary';
import {
  DIAG,
  applyBackdropFlag,
  applyLegacyFx,
  runBenchIfRequested,
  runJankIfRequested,
  runMatrixIfRequested,
} from './diag/diagnostics';
import { DiagOverlay } from './diag/DiagOverlay';
import './App.css';

function StageLegend() {
  const byStage = useApsis((s) => s.telemetry.byStage);
  return (
    <section className="panel">
      <h2>Lead Temperature</h2>
      <ul className="legend">
        {STAGE_ORDER.map((id) => (
          <li key={id}>
            <span className="dot" style={{ background: STAGES[id].color }} />
            <span className="legend-label">{STAGES[id].label}</span>
            <span className="legend-band">{bandLabel(id)}</span>
            <span className="legend-count">{byStage[id].toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActivityFeed() {
  const feed = useApsis((s) => s.feed);
  const agents = useApsis((s) => s.agents);
  const leads = useApsis((s) => s.leads);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  return (
    <section className="panel grow">
      <h2>Live Activity</h2>
      <ul className="feed">
        {feed.slice(0, 14).map((e) => {
          const agent = e.agentId ? byId.get(e.agentId) : null;
          const lead = leads.get(e.leadId);
          return (
            <li key={e.id}>
              <span
                className="dot"
                style={{ background: agent?.color ?? '#55607a' }}
              />
              <span className="feed-kind">{e.kind.replace(/_/g, ' ')}</span>
              <span className="feed-lead">{lead?.name ?? e.leadId}</span>
            </li>
          );
        })}
        {feed.length === 0 && <li className="muted">Waiting for events…</li>}
      </ul>
    </section>
  );
}

function Telemetry() {
  const t = useApsis((s) => s.telemetry);
  return (
    <section className="panel">
      <h2>Pipeline</h2>
      <div className="stats">
        <div>
          <span className="stat-n">{t.total.toLocaleString()}</span>
          <span className="stat-l">Total leads</span>
        </div>
        <div>
          <span className="stat-n accent">{t.booked.toLocaleString()}</span>
          <span className="stat-l">Booked</span>
        </div>
        <div>
          <span className="stat-n">{t.eventRate}</span>
          <span className="stat-l">Events / min</span>
        </div>
      </div>
    </section>
  );
}

/**
 * Reset control (§ Persistence v1).
 *
 * Two-step rather than a modal: destroying a session needs a deliberate second
 * action, and the existing shell has no dialog pattern to borrow. The armed
 * state disarms itself after a few seconds so a stray click cannot leave a
 * loaded gun in the toolbar. Reload is what restores the seeded book, because
 * the store seeds once at module load — no second reset path to keep correct.
 */
function ResetSession({ controller }: { controller: React.RefObject<PersistenceController | null> }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [armed]);

  return (
    <button
      className="toggle"
      title="Clear the saved session and reseed the book"
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        void (controller.current?.clear() ?? Promise.resolve()).then(() => window.location.reload());
      }}
    >
      {armed ? 'Confirm reset' : 'Reset session'}
    </button>
  );
}

export default function App() {
  const [live, setLive] = useState(true);
  const [booting, setBooting] = useState(true);
  const persistence = useRef<PersistenceController | null>(null);
  const booked = useApsis((s) => s.telemetry.booked);

  // Restore the saved session BEFORE any source runs. `bootSession` is a
  // singleton promise, so React StrictMode's double-invoke cannot hydrate the
  // log twice — which would double-apply every event in it.
  useEffect(() => {
    let cancelled = false;
    void bootSession().then(({ controller }) => {
      if (cancelled) return;
      persistence.current = controller;
      refreshPersistenceStatus(controller);
      setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Durability across a tab close: the debounced write may not have fired yet.
  useEffect(() => {
    const flush = () => void persistence.current?.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  useEffect(() => {
    // `?feed=off` silences the event source for diagnosis — it is the trigger
    // for the per-event full-book revision walk, so removing it separates that
    // cost from steady-state rendering. Defaults to on.
    // Wait for restore to finish: starting a source mid-hydration would
    // interleave live events with restored history and record the mixture.
    if (booting || !live || !DIAG.feed) return;
    // `?source=replay` swaps the transport; everything downstream — scoring,
    // gravity, agents, the rail, the Universe — is unaware which one is running.
    const source = createConfiguredSource();
    source.start();
    return () => source.stop();
  }, [live, booting]);

  // All no-ops without their flags.
  useEffect(() => {
    applyBackdropFlag();
    applyLegacyFx();
    runBenchIfRequested();
    runJankIfRequested();
    runMatrixIfRequested();
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          APSIS
        </div>
        <div className="title">
          Lead Universe
          <small>periapsis is a booked appointment</small>
        </div>
        <button className="toggle" onClick={() => setLive((v) => !v)}>
          {live ? 'Pause feed' : 'Resume feed'}
        </button>
        <ResetSession controller={persistence} />
      </header>

      {/* The canvas is a presentation of data that is also published as real DOM
          in the rail. Exposing it to assistive tech would announce an unlabelled
          graphic with no structure; the Leads list is its accessible equivalent. */}
      <main className="stage">
        {/* The boundary sits OUTSIDE the aria-hidden wrapper on purpose: the
            canvas is decorative, but a message explaining why it is missing is
            not, and would be unreachable to a screen reader inside it. */}
        <UniverseBoundary>
          <div className="canvas-wrap" aria-hidden="true">
            <Universe />
          </div>
        </UniverseBoundary>
        <div className="center-readout">
          <span className="center-n">{booked.toLocaleString()}</span>
          <span className="center-l">Booked appointments</span>
        </div>
        <CommandBar />
        <p className="canvas-hint">
          Arrow keys orbit · <kbd>+</kbd>/<kbd>−</kbd> zoom · the Leads list is
          fully keyboard navigable
        </p>
      </main>

      <aside className="rail">
        <StatusAnnouncer />
        <SelectionAnnouncer />
        <SystemState />
        <Telemetry />
        <LeadDetail />
        <AppointmentCentre />
        <AgentRoster />
        <StageLegend />
        <LeadList />
        <Orchestrator />
        <ActivityFeed />
      </aside>

      {/* Renders nothing without `?diag=1`. */}
      <DiagOverlay />
    </div>
  );
}
