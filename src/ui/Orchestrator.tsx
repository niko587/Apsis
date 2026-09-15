/**
 * Model orchestration, made visible (§35).
 *
 * "Never hide this distinction from the user." The panel's most important line is
 * not which model was chosen — it is whether Apsis can actually switch to it, or
 * whether a human has to. Those two states look identical in a product that
 * reports only the choice, and §37.2 exists because that is exactly the lie such
 * a product tells.
 *
 * The routing shown here is real: it runs the same `route()` the engine exposes,
 * against capabilities the environment actually declared. In an undeclared
 * environment it reports that nothing is reachable rather than inventing a plan.
 */

import { useMemo, useState } from 'react';
import { buildRegistry, detectCapabilities, routingMode } from '../orchestrator/registry';
import { makeTask, route } from '../orchestrator/router';
import { switchInstruction } from '../orchestrator/handoff';
import type { Task } from '../orchestrator/types';

/**
 * The remaining project phases, as the master prompt defines them.
 *
 * Static because they describe the plan, not runtime state — but each one is
 * routed live, so the panel reflects the real policy rather than a stored answer.
 */
const PIPELINE: Task[] = [
  makeTask({
    id: 'phase_visual',
    description: 'Bloom pipeline, lead motion trails, volumetric Intelligence Core',
    type: 'shaders',
    complexity: 0.8,
    visualComplexity: 0.95,
    reasoningComplexity: 0.2,
    currentProjectPhase: 'Visual refinement',
  }),
  makeTask({
    id: 'phase_cluster',
    description: 'Cluster / zoom camera choreography into a stage annulus',
    type: 'animation',
    complexity: 0.6,
    visualComplexity: 0.8,
    reasoningComplexity: 0.3,
    currentProjectPhase: 'Cluster & zoom',
  }),
  makeTask({
    id: 'phase_appointments',
    description: 'Appointment centre detail — booked pipeline, scheduling surface',
    type: 'business_logic',
    complexity: 0.55,
    reasoningComplexity: 0.6,
    integrationComplexity: 0.5,
    currentProjectPhase: 'Appointment centre',
  }),
  makeTask({
    id: 'phase_crm',
    description: 'Replace the simulated source with a real CRM transport',
    type: 'api_integration',
    complexity: 0.75,
    reasoningComplexity: 0.7,
    integrationComplexity: 0.9,
    currentProjectPhase: 'CRM integration',
  }),
];

export function Orchestrator() {
  const [expanded, setExpanded] = useState(false);

  const { registry, mode, decisions } = useMemo(() => {
    const env = detectCapabilities();
    const registry = buildRegistry(env);
    return {
      registry,
      mode: routingMode(registry),
      decisions: PIPELINE.map((t) => route(t, registry, { activeModel: env.activeModel })),
    };
  }, []);

  const next = decisions[0];
  const instruction = switchInstruction(next);

  return (
    <section className="panel">
      <h2>
        Model Orchestrator
        <span className={`route-mode route-${mode}`}>
          {mode === 'automated' ? 'AUTO ROUTING: ON' : 'AUTO ROUTING: ASSISTED'}
        </span>
      </h2>

      {next.blocked ? (
        <p className="orch-blocked">{next.blocked}</p>
      ) : (
        <>
          <div className="orch-next">
            <span className="orch-model">{next.selectedModel?.toUpperCase()}</span>
            <span className="orch-phase">{next.phase}</span>
          </div>
          <p className="orch-reason">{next.reason}</p>
          {next.fallbackModel && (
            <p className="orch-fallback">
              Fallback: {next.fallbackModel}
              {' · '}confidence {(next.confidence * 100).toFixed(0)}%
            </p>
          )}
        </>
      )}

      {instruction && <p className="orch-action">{instruction}</p>}

      <button className="orch-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'Hide' : 'Show'} routing plan
      </button>

      {expanded && (
        <>
          <ol className="orch-plan">
            {decisions.map((d) => (
              <li key={d.task.id}>
                <span className="orch-plan-model">
                  {d.selectedModel?.toUpperCase() ?? '—'}
                </span>
                <span className="orch-plan-phase">{d.phase}</span>
                {d.requiresUserSwitch && <span className="orch-manual">manual</span>}
              </li>
            ))}
          </ol>
          <ul className="orch-registry">
            {registry.map((m) => (
              <li key={m.id}>
                <span>{m.label}</span>
                <span className={`orch-inv orch-inv-${m.invocation}`}>{m.invocation}</span>
              </li>
            ))}
          </ul>
          <p className="orch-note">
            Reachability is read from what this environment declares, never assumed
            from a model existing. Nothing is reported as used unless it ran.
          </p>
        </>
      )}
    </section>
  );
}
