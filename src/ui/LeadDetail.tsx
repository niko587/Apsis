/**
 * Lead detail.
 *
 * Shows the selected lead, falling back to the hovered one so the field is
 * readable on the way to a click rather than only after it.
 */

import { useMemo } from 'react';
import { useApsis } from '../state/store';
import { useThrottledRevision } from './useThrottledRevision';
import { STAGES } from '../domain/types';
import { radiusFor, APOAPSIS } from '../domain/gravity';
import { nextBestAction } from '../domain/nextAction';

const rel = (ms: number) => {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function LeadDetail() {
  const selectedId = useApsis((s) => s.selectedLeadId);
  const hoveredId = useApsis((s) => s.hoveredLeadId);
  const leads = useApsis((s) => s.leads);
  const feed = useApsis((s) => s.feed);
  // Throttled: keying off the raw revision rebuilds this on every ingested
  // event, which is ~9 times a second. See useThrottledRevision.
  const revision = useThrottledRevision();
  const select = useApsis((s) => s.select);
  const claimed = useApsis((s) => s.claimed);
  const requestWork = useApsis((s) => s.requestWork);
  const taskRevision = useApsis((s) => s.taskRevision);

  const id = selectedId ?? hoveredId;
  // `revision` is read above so this recomputes as the lead's score moves —
  // without it the panel would freeze at whatever the score was on selection.
  const lead = useMemo(() => (id ? leads.get(id) : null), [id, leads, revision]);
  const history = useMemo(
    () => (id ? feed.filter((e) => e.leadId === id).slice(0, 6) : []),
    [id, feed],
  );

  if (!lead) {
    return (
      <section className="panel">
        <h2>Lead</h2>
        <p className="muted">Hover the field to inspect a lead. Click to pin it.</p>
      </section>
    );
  }

  const spec = STAGES[lead.stage];
  // Recomputed from live state every render — see nextAction.ts for why this is
  // derived rather than stored. `taskRevision` is read so it updates the moment
  // an agent picks the lead up.
  void taskRevision;
  const action = nextBestAction(lead, Date.now(), claimed.has(lead.id));
  // How far in the lead has travelled, as a share of the whole journey.
  const progress = 1 - (radiusFor(lead.score) - radiusFor(100)) / (APOAPSIS - radiusFor(100));

  return (
    <section className="panel">
      <h2>
        Lead
        {selectedId && (
          <button className="unpin" onClick={() => select(null)}>
            unpin
          </button>
        )}
      </h2>

      <div className="lead-head">
        <span className="lead-name">{lead.name}</span>
        <span className="lead-score" style={{ color: spec.color }}>
          {Math.round(lead.score)}
        </span>
      </div>

      <div className="lead-stage">
        <span className="dot" style={{ background: spec.color }} />
        {spec.label}
      </div>

      <div className="approach">
        <div className="approach-bar">
          <div
            className="approach-fill"
            style={{ width: `${(progress * 100).toFixed(1)}%`, background: spec.color }}
          />
        </div>
        <span className="approach-l">
          {(progress * 100).toFixed(0)}% of the way to periapsis
        </span>
      </div>

      <div className={`nba nba-${action.urgency}`}>
        <div className="nba-head">
          <span className="nba-label">{action.label}</span>
          {action.emits && (
            <button
              className="nba-run"
              onClick={() => requestWork(lead.id, action.emits!)}
            >
              Execute
            </button>
          )}
        </div>
        <p className="nba-reason">{action.reason}</p>
      </div>

      <dl className="lead-meta">
        <dt>Phone</dt>
        <dd>{lead.phone}</dd>
        <dt>Email</dt>
        <dd className="lead-email">{lead.email}</dd>
        <dt>Age</dt>
        <dd>{lead.age}</dd>
        <dt>Occupation</dt>
        <dd>{lead.occupation}</dd>
        <dt>Current coverage</dt>
        <dd>{lead.currentCoverage ?? <span className="uninsured">Uninsured</span>}</dd>
        <dt>Prefers</dt>
        <dd>{lead.preferredContact}</dd>
        <dt>Location</dt>
        <dd>{lead.location}</dd>
        <dt>Segment</dt>
        <dd>{lead.segment}</dd>
        <dt>Intent</dt>
        <dd>{(lead.intent * 100).toFixed(0)}%</dd>
        <dt>Last event</dt>
        <dd>{rel(lead.lastEventAt)}</dd>
        {lead.appointmentAt && (
          <>
            <dt>Appointment</dt>
            <dd className="booked">{rel(lead.appointmentAt)}</dd>
          </>
        )}
      </dl>

      {lead.needs.length > 0 && (
        <ul className="needs">
          {lead.needs.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <ul className="lead-history">
          {history.map((e) => (
            <li key={e.id}>
              <span className="feed-kind">{e.kind.replace(/_/g, ' ')}</span>
              <span className="feed-lead">{rel(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
