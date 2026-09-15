/**
 * The Apsis shell.
 *
 * Every number on screen is read from the same store the Universe renders from,
 * so the HUD and the field can never disagree.
 */

import { useEffect, useMemo, useState } from 'react';
import { Universe } from './universe/Universe';
import { useApsis } from './state/store';
import { createSimulatedSource } from './state/source';
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

export default function App() {
  const [live, setLive] = useState(true);
  const booked = useApsis((s) => s.telemetry.booked);

  useEffect(() => {
    if (!live) return;
    const source = createSimulatedSource({ eventsPerSecond: 9 });
    source.start();
    return () => source.stop();
  }, [live]);

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
    </div>
  );
}
