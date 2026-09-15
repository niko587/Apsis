/**
 * Agent roster.
 *
 * Counts are derived from the live task set, not accumulated separately — the
 * roster and the arcs in the Universe are reading the same thing, so "3 active"
 * here always means three arcs on screen.
 */

import { useMemo } from 'react';
import { useApsis } from '../state/store';

export function AgentRoster() {
  const agents = useApsis((s) => s.agents);
  const tasks = useApsis((s) => s.tasks);
  const taskRevision = useApsis((s) => s.taskRevision);
  const leads = useApsis((s) => s.leads);
  const select = useApsis((s) => s.select);

  // `taskRevision` is read so this recomputes when the task map mutates in
  // place — the Map identity never changes, so it alone would not trigger.
  const byAgent = useMemo(() => {
    const m = new Map<string, { count: number; leadId: string | null }>();
    for (const t of tasks.values()) {
      const cur = m.get(t.agentId) ?? { count: 0, leadId: null };
      m.set(t.agentId, { count: cur.count + 1, leadId: cur.leadId ?? t.leadId });
    }
    return m;
  }, [tasks, taskRevision]);

  const active = [...byAgent.values()].reduce((n, v) => n + v.count, 0);

  return (
    <section className="panel">
      <h2>
        AI Agents
        <span className="h2-aside">{active} working</span>
      </h2>
      <ul className="agents">
        {agents.map((a) => {
          const work = byAgent.get(a.id);
          const lead = work?.leadId ? leads.get(work.leadId) : null;
          return (
            <li
              key={a.id}
              className={work ? 'busy' : 'idle'}
              onClick={() => work?.leadId && select(work.leadId)}
            >
              <span className="dot" style={{ background: a.color }} />
              <span className="agent-label">{a.label}</span>
              {work ? (
                <span className="agent-work" title={lead?.name ?? ''}>
                  {work.count === 1 ? (lead?.name ?? '1 lead') : `${work.count} leads`}
                </span>
              ) : (
                <span className="agent-idle">idle</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
