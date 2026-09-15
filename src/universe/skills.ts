/**
 * Active Skills (§12) — derived, never simulated.
 *
 * The critical constraint from the spec: do NOT display all skills as active.
 * A skill appears only while it is genuinely in one of READY / ACTIVE /
 * EXECUTING / COMPLETE / ERROR, and every one of those states is DERIVED from
 * store facts that already exist:
 *
 *   EXECUTING — the skill's agent holds in-flight `AgentTask`s right now.
 *   COMPLETE  — its most recent task resolved into a feed event moments ago
 *               (the entry then expires; `until` says when).
 *   ERROR     — that resolution was a failure outcome (e.g. no answer).
 *   ACTIVE    — Lead Intelligence: inbound events are being scored in the
 *               trailing window. Scoring is continuous work, not a task, so it
 *               is "active" rather than "executing".
 *   READY     — intentionally unused. Nothing upstream of `startTask` exists in
 *               the store (dispatch claims the lead and starts in one motion),
 *               so a READY display would be an invented state — exactly what
 *               §12 forbids. If a queue-before-claim ever exists, it maps here.
 *
 * There is no timer driving any of this: time only ever EXPIRES a display
 * (`until`), it never creates one. Pure module, testable like the domain.
 */

import type { AgentTask, Lead, LeadEvent, LeadEventKind } from '../domain/types';

export type SkillStatus = 'READY' | 'ACTIVE' | 'EXECUTING' | 'COMPLETE' | 'ERROR';

export interface SkillSpec {
  readonly id: string;
  /** The agent whose tasks this skill surfaces, or null for derived skills. */
  readonly agentId: string | null;
  readonly label: string;
  readonly color: string;
}

/** Colors deliberately mirror the backing agent's, so the §23 chain
 *  (Core → skill → agent → lead) reads as one circuit. */
export const SKILLS: readonly SkillSpec[] = [
  { id: 'skill_intelligence', agentId: null, label: 'Lead Intelligence', color: '#8f6bff' },
  { id: 'skill_qualification', agentId: 'agent_qualification', label: 'Qualification', color: '#ff9a1f' },
  { id: 'skill_sms', agentId: 'agent_sms', label: 'SMS Outreach', color: '#12c8e0' },
  { id: 'skill_email', agentId: 'agent_email', label: 'Email Outreach', color: '#ff45d0' },
  { id: 'skill_call', agentId: 'agent_call', label: 'Calling', color: '#7b8cff' },
  { id: 'skill_booking', agentId: 'agent_booking', label: 'Booking', color: '#2fe08a' },
  { id: 'skill_follow_up', agentId: 'agent_follow_up', label: 'Follow-Up', color: '#ffd23f' },
  { id: 'skill_reactivation', agentId: 'agent_reactivation', label: 'Reactivation', color: '#ff3b57' },
];

/** How long a resolved task keeps its COMPLETE/ERROR entry on screen. */
export const SETTLE_MS = 4_000;
/** Trailing window over which Lead Intelligence counts scored leads. */
export const INTEL_WINDOW_MS = 10_000;

/** Present-tense phrasing for in-flight work, past for resolved. */
const VERBS: Partial<Record<LeadEventKind, [doing: string, done: string]>> = {
  contacted: ['reaching out to', 'reached'],
  call_connected: ['on a call with', 'finished call with'],
  call_no_answer: ['dialing', 'no answer from'],
  qualified: ['analyzing', 'qualified'],
  appointment_offered: ['checking availability for', 'offered a slot to'],
  appointment_booked: ['booking', 'booked'],
  went_cold: ['re-engaging', 'followed up with'],
};

/** Outcomes that read as failures rather than progress. */
const FAILURE: ReadonlySet<LeadEventKind> = new Set([
  'call_no_answer',
  'appointment_cancelled',
  'unsubscribed',
]);

export interface SkillActivity {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly status: SkillStatus;
  /** e.g. "analyzing Sarah Martinez" or "scoring 42 leads". */
  readonly detail: string;
  /** Leads currently involved. */
  readonly count: number;
  /** Wall-clock ms after which this entry expires, or Infinity while live. */
  readonly until: number;
}

const leadName = (leads: ReadonlyMap<string, Lead>, id: string) =>
  leads.get(id)?.name ?? id;

/**
 * The skills Apsis is using RIGHT NOW. Skills with nothing to show are absent
 * from the result — absence IS the §12 requirement.
 *
 * Allocates freely; callers are DOM panels on a throttled cadence and the 3D
 * ring's own per-frame path reads the task map directly instead.
 */
export function deriveSkills(
  tasks: ReadonlyMap<string, AgentTask>,
  feed: readonly LeadEvent[],
  leads: ReadonlyMap<string, Lead>,
  now: number,
): SkillActivity[] {
  // Per-agent tally of in-flight work.
  const inFlight = new Map<string, { count: number; last: AgentTask }>();
  for (const task of tasks.values()) {
    const t = inFlight.get(task.agentId);
    if (t) {
      t.count++;
      t.last = task;
    } else {
      inFlight.set(task.agentId, { count: 1, last: task });
    }
  }

  // Most recent settled event per agent inside the settle window, plus the
  // Lead Intelligence tally. Feed is newest-first and capped, so one bounded walk.
  const settled = new Map<string, LeadEvent>();
  const scored = new Set<string>();
  for (const e of feed) {
    const age = now - e.at;
    if (age > INTEL_WINDOW_MS) break;
    scored.add(e.leadId); // every event re-scores its lead — that IS the engine
    if (e.agentId && age <= SETTLE_MS && !settled.has(e.agentId)) {
      settled.set(e.agentId, e);
    }
  }

  const out: SkillActivity[] = [];
  for (const spec of SKILLS) {
    if (spec.agentId === null) {
      // Lead Intelligence: continuous scoring over the trailing window.
      if (scored.size === 0) continue;
      out.push({
        id: spec.id,
        label: spec.label,
        color: spec.color,
        status: 'ACTIVE',
        detail: `scoring ${scored.size} lead${scored.size === 1 ? '' : 's'}`,
        count: scored.size,
        until: Infinity,
      });
      continue;
    }

    const flight = inFlight.get(spec.agentId);
    if (flight) {
      const verb = VERBS[flight.last.emits]?.[0] ?? 'working';
      out.push({
        id: spec.id,
        label: spec.label,
        color: spec.color,
        status: 'EXECUTING',
        detail:
          flight.count === 1
            ? `${verb} ${leadName(leads, flight.last.leadId)}`
            : `working ${flight.count} leads`,
        count: flight.count,
        until: Infinity,
      });
      continue;
    }

    const done = settled.get(spec.agentId);
    if (done) {
      const failed = FAILURE.has(done.kind);
      const verb = VERBS[done.kind]?.[1] ?? done.kind.replace(/_/g, ' ');
      out.push({
        id: spec.id,
        label: spec.label,
        color: spec.color,
        status: failed ? 'ERROR' : 'COMPLETE',
        detail: `${verb} ${leadName(leads, done.leadId)}`,
        count: 1,
        until: done.at + SETTLE_MS,
      });
    }
    // Neither in flight nor recently settled → the skill does not appear. Ever.
  }
  return out;
}
