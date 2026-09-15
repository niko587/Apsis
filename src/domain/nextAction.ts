/**
 * Next best action (§14).
 *
 * Derived, never stored. The recommendation is a pure function of the lead's
 * current state, so it can never go stale — the moment a score moves or an agent
 * picks the lead up, the advice recomputes. A stored recommendation would need
 * invalidating on every event that could affect it, and the failure mode is a
 * confident instruction to "call now" for someone an agent is already calling.
 *
 * It also respects the lead's own stated preference. Recommending a phone call
 * to someone who asked to be emailed is worse than recommending nothing.
 */

import { STAGES, type Lead, type LeadEventKind } from './types';

export interface NextAction {
  /** Imperative, short enough to be a button label. */
  readonly label: string;
  /** Why this, now. Shown under the label. */
  readonly reason: string;
  /** The event executing it would produce, or null when nothing should be done. */
  readonly emits: LeadEventKind | null;
  readonly urgency: 'low' | 'normal' | 'high';
}

const DAY = 1000 * 60 * 60 * 24;

const CHANNEL_VERB: Record<Lead['preferredContact'], string> = {
  phone: 'Call',
  sms: 'Send SMS to',
  email: 'Email',
};

/**
 * @param busy whether an agent currently holds this lead
 */
export function nextBestAction(lead: Lead, now: number, busy: boolean): NextAction {
  // An agent is already on it. Recommending a second touch is how a lead gets
  // called twice in five minutes.
  if (busy) {
    return {
      label: 'Wait — agent working',
      reason: 'An agent currently holds this lead. A second touch would collide.',
      emits: null,
      urgency: 'low',
    };
  }

  if (lead.stage === 'booked') {
    return {
      label: 'Confirm appointment',
      reason: 'Booked. Nothing to advance — protect the appointment.',
      emits: null,
      urgency: 'low',
    };
  }

  const idleDays = (now - lead.lastEventAt) / DAY;
  const verb = CHANNEL_VERB[lead.preferredContact];

  // Stale beats stage: a hot lead nobody has touched in three weeks needs
  // reviving before it needs advancing, and it is cooling by the day.
  if (idleDays >= 14 && lead.score >= STAGES.contacted.lo) {
    return {
      label: `${verb} — reactivate`,
      reason: `No contact in ${Math.floor(idleDays)} days and cooling. Prefers ${lead.preferredContact}.`,
      emits: 'contacted',
      urgency: 'high',
    };
  }

  if (lead.stage === 'appointment_ready') {
    return {
      label: 'Offer an appointment slot',
      reason: `Score ${Math.round(lead.score)} — qualified and ready. Only a booking reaches the centre.`,
      emits: 'appointment_offered',
      urgency: 'high',
    };
  }

  if (lead.stage === 'hot') {
    return {
      label: 'Offer an appointment slot',
      reason: `Hot at ${Math.round(lead.score)}. Intent ${(lead.intent * 100).toFixed(0)}%.`,
      emits: 'appointment_offered',
      urgency: 'high',
    };
  }

  if (lead.stage === 'qualified') {
    return {
      label: 'Confirm needs and qualify',
      reason: `Qualified but not yet hot. Stated: ${lead.needs[0] ?? 'no needs captured'}.`,
      emits: 'qualified',
      urgency: 'normal',
    };
  }

  if (lead.stage === 'engaged') {
    return {
      label: `${verb} to qualify`,
      reason: `Engaged and responsive. Prefers ${lead.preferredContact}.`,
      emits: 'call_connected',
      urgency: 'normal',
    };
  }

  if (lead.stage === 'contacted') {
    return {
      label: `${verb} — follow up`,
      reason: 'Contacted but not yet engaged. One more touch on their channel.',
      emits: 'contacted',
      urgency: 'normal',
    };
  }

  return {
    label: `${verb} — first touch`,
    reason: lead.currentCoverage
      ? `Cold. Currently on ${lead.currentCoverage}.`
      : 'Cold and currently uninsured — a strong opening.',
    emits: 'contacted',
    urgency: lead.currentCoverage ? 'low' : 'normal',
  };
}
