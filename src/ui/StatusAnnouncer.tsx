/**
 * Non-visual status (§21).
 *
 * The Universe communicates pipeline state through colour, radius and motion —
 * none of which reaches a screen reader. This is the same state as speech.
 *
 * Deliberately NOT a live region over the raw event feed. At ~9 events/sec that
 * would produce continuous, unusable chatter and drown out everything else on
 * the page. Instead it announces on a slow cadence, only when a figure has
 * actually moved, and only the figures that mean something: how many
 * appointments are booked and what the agents are doing.
 */

import { useEffect, useRef, useState } from 'react';
import { useApsis } from '../state/store';

const ANNOUNCE_INTERVAL_MS = 15_000;
/** Grace period before the first announcement, so it reflects a running system. */
const SETTLE_MS = 2_500;

export function StatusAnnouncer() {
  const [message, setMessage] = useState('');
  const last = useRef('');

  useEffect(() => {
    const tick = () => {
      const { telemetry, tasks } = useApsis.getState();
      const next =
        `${telemetry.booked} appointments booked. ` +
        `${telemetry.byStage.hot + telemetry.byStage.appointment_ready} leads close to booking. ` +
        `${tasks.size} agent ${tasks.size === 1 ? 'task' : 'tasks'} in progress.`;
      if (next !== last.current) {
        last.current = next;
        setMessage(next);
      }
    };
    // Deliberately not announcing at mount. At t=0 no agent has picked anything
    // up yet, so the first thing spoken would be "0 agent tasks in progress" —
    // and it would stand for a full interval while the pipeline is visibly busy.
    // Let the state settle first.
    const settle = window.setTimeout(tick, SETTLE_MS);
    const id = window.setInterval(tick, ANNOUNCE_INTERVAL_MS);
    return () => {
      window.clearTimeout(settle);
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

/**
 * Announces the selected lead immediately.
 *
 * Separate region from the periodic status: selection is a direct response to a
 * user action and must be spoken at once, not folded into the next slow tick.
 */
export function SelectionAnnouncer() {
  const selectedId = useApsis((s) => s.selectedLeadId);
  const leads = useApsis((s) => s.leads);
  const lead = selectedId ? leads.get(selectedId) : null;

  return (
    <div className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
      {lead
        ? `Selected ${lead.name}, ${lead.segment}, ${lead.location}, score ${Math.round(lead.score)}.`
        : ''}
    </div>
  );
}
