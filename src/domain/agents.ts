/**
 * Agent work model.
 *
 * The distinction this module draws is the whole point of it: some events are
 * things an AGENT DID, and some are things the LEAD did. An agent dialling a
 * number is work — it occupies that agent, takes time, and resolves into an
 * event. A lead opening an email is not work; it simply arrives.
 *
 * So agent-driven events are produced by a task with a lifetime, and inbound
 * events are ingested directly. Treating both the same is what makes an "agent
 * network" a caption rather than a system.
 */

import { STAGES, type Lead, type LeadEventKind } from './types';
import { stableHash } from './seed';

/**
 * Baseline agent per event kind. `null` means the lead initiated it.
 *
 * This is the DEFAULT, not the final answer — `agentFor` refines it using the
 * lead. Keying work off the event kind alone left two of the seven agents
 * (email, reactivation) with no event that could ever route to them, so they sat
 * permanently idle in the roster: rostered, rendered, and never doing anything.
 */
export const AGENT_FOR: Readonly<Record<LeadEventKind, string | null>> = {
  ingested: null,
  contacted: 'agent_sms',
  opened: null,
  clicked: null,
  replied: null,
  call_connected: 'agent_call',
  call_no_answer: 'agent_call',
  qualified: 'agent_qualification',
  objection: null,
  appointment_offered: 'agent_booking',
  appointment_booked: 'agent_booking',
  appointment_cancelled: null,
  went_cold: 'agent_follow_up',
  unsubscribed: null,
};

export const isAgentDriven = (kind: LeadEventKind): boolean => AGENT_FOR[kind] !== null;

/**
 * Which agent actually picks up this work.
 *
 * Two refinements over the flat mapping:
 *
 * - **Outreach channel is a property of the LEAD.** Some people answer texts and
 *   some answer email, so `contacted` routes to SMS or email by a stable hash of
 *   the lead id rather than at random. A given lead is always worked the same way.
 *
 * - **Reactivation is for leads that were once warm.** A lead going cold from
 *   `cold` is just routine follow-up; one going cold after reaching engaged or
 *   better is a lapsed opportunity, which is exactly the reactivation agent's job.
 */
export function agentFor(kind: LeadEventKind, lead: Lead): string | null {
  const base = AGENT_FOR[kind];
  if (base === null) return null;

  if (kind === 'contacted') {
    return stableHash(lead.id) < 0.52 ? 'agent_sms' : 'agent_email';
  }
  if (kind === 'went_cold') {
    return lead.score >= STAGES.engaged.lo ? 'agent_reactivation' : 'agent_follow_up';
  }
  return base;
}

/**
 * How long a unit of agent work occupies the agent, in ms.
 *
 * These are latencies, not animation timings — a call takes longer than an SMS
 * because placing a call takes longer than sending a text. When a real executor
 * is wired in (an LLM call, a dialer API) it reports its own duration and these
 * defaults go away; the task lifecycle around them does not change.
 */
const DURATION: Partial<Record<LeadEventKind, [min: number, max: number]>> = {
  contacted: [900, 2200],
  call_connected: [3200, 8000],
  call_no_answer: [2400, 4800],
  qualified: [2600, 6000],
  appointment_offered: [1800, 3800],
  appointment_booked: [2400, 5200],
  went_cold: [800, 1800],
};

export function taskDuration(kind: LeadEventKind, u: number): number {
  const range = DURATION[kind] ?? [1000, 2000];
  return range[0] + u * (range[1] - range[0]);
}
