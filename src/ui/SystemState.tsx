/**
 * Apsis state and current focus (§17).
 *
 * "Do not make telemetry decorative. Every important number should come from
 * actual application state."
 *
 * Both lines here are derived, never stored. `PROCESSING` reflects in-flight
 * agent tasks and live event throughput; the focus line comes from the last
 * PARSED command. A stored status flag needs something to remember to clear it,
 * and the moment that fails the most prominent word on the panel is wrong.
 */

import { useEffect, useState } from 'react';
import { systemState, useApsis } from '../state/store';

export function SystemState() {
  const focus = useApsis((s) => s.focus);
  const [state, setState] = useState<'processing' | 'idle'>(() => systemState());

  // Polled rather than subscribed: the derived state depends on task count AND
  // the trailing event rate, so there is no single store field to watch, and a
  // subscription on `revision` would re-render this twice a second for a value
  // that changes far less often.
  useEffect(() => {
    const id = window.setInterval(() => {
      setState((prev) => {
        const next = systemState();
        return prev === next ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="panel">
      <h2>Apsis State</h2>
      <div className={`sys-state sys-${state}`}>
        <span className="sys-dot" />
        {state === 'processing' ? 'PROCESSING' : 'IDLE'}
      </div>

      <h3 className="sys-sub">Current focus</h3>
      <p className="sys-focus">
        {focus ?? <span className="muted">Monitoring the full book — no active command.</span>}
      </p>
    </section>
  );
}
