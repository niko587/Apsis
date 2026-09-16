/**
 * The built-in replay fixture.
 *
 * A short, legible session that exercises the real pipeline end to end: every
 * kind below is a genuine `LeadEventKind` the scoring engine already handles —
 * nothing was invented to make the demo look busier than the product is.
 *
 * Three narratives run in parallel so the field shows more than one behaviour:
 *
 *   lead_0000  the full journey inward — contacted, opened, replied, a
 *              connected call, qualified, offered, booked. It ends at periapsis,
 *              which is the only way a lead reaches the centre (D3).
 *   lead_0001  the other direction — contacted, no answer, objection, cold.
 *              A universe where everything improves is a screensaver.
 *   lead_0002  engagement without commitment — opened, clicked, replied.
 *
 * WHY THIS IS A FUNCTION, NOT A CONSTANT
 * `LeadEvent.at` is domain data: appointments are scheduled from it, and a
 * hard-coded absolute timestamp would book every demo appointment in the past.
 * Taking the base as a parameter means the URL path can anchor the session to
 * now while tests pass a fixed base and get exact determinism. The session is
 * *constructed* with real timestamps rather than recorded events being rewritten
 * afterwards — recorded events are never mutated.
 *
 * WHY THESE LEAD IDS ARE SAFE
 * `seedLeads` assigns `lead_${index}` from a fresh `rng(seed)`, so `lead_0000`
 * through `lead_0002` exist with identical seeded scores for any book size,
 * including `?leads=N`. If a lead id is ever absent, `ingest` returns early and
 * the replay simply has no effect — it cannot corrupt state.
 */

import { REPLAY_FORMAT_VERSION, type ReplaySession } from '../replay';
import type { LeadEventKind } from '../../domain/types';

/** Agent ids match `seedAgents()` (`agent_${kind}`), so attribution is real. */
interface Beat {
  offsetMs: number;
  leadId: string;
  kind: LeadEventKind;
  agentId: string | null;
}

const BEATS: readonly Beat[] = [
  { offsetMs: 0, leadId: 'lead_0000', kind: 'contacted', agentId: 'agent_sms' },
  { offsetMs: 400, leadId: 'lead_0001', kind: 'contacted', agentId: 'agent_call' },
  { offsetMs: 900, leadId: 'lead_0002', kind: 'opened', agentId: null },
  { offsetMs: 1500, leadId: 'lead_0000', kind: 'opened', agentId: null },
  { offsetMs: 2100, leadId: 'lead_0001', kind: 'call_no_answer', agentId: 'agent_call' },
  { offsetMs: 2600, leadId: 'lead_0002', kind: 'clicked', agentId: null },
  { offsetMs: 3200, leadId: 'lead_0000', kind: 'replied', agentId: null },
  { offsetMs: 3900, leadId: 'lead_0002', kind: 'replied', agentId: null },
  { offsetMs: 4600, leadId: 'lead_0000', kind: 'call_connected', agentId: 'agent_call' },
  { offsetMs: 5400, leadId: 'lead_0001', kind: 'objection', agentId: 'agent_call' },
  { offsetMs: 6200, leadId: 'lead_0000', kind: 'qualified', agentId: 'agent_qualification' },
  { offsetMs: 7000, leadId: 'lead_0001', kind: 'went_cold', agentId: null },
  { offsetMs: 7800, leadId: 'lead_0000', kind: 'appointment_offered', agentId: 'agent_booking' },
  { offsetMs: 8800, leadId: 'lead_0000', kind: 'appointment_booked', agentId: 'agent_booking' },
];

/**
 * Build the fixture session anchored at `startedAt`.
 *
 * @param startedAt wall clock the session should appear to have begun at.
 */
export function demoSession(startedAt: number): ReplaySession {
  return {
    version: REPLAY_FORMAT_VERSION,
    name: 'built-in demo',
    recordedAt: startedAt,
    events: BEATS.map((beat, i) => ({
      offsetMs: beat.offsetMs,
      event: {
        // Stable, collision-free ids: the store keys the feed by them.
        id: `replay_${i.toString().padStart(3, '0')}`,
        leadId: beat.leadId,
        kind: beat.kind,
        at: startedAt + beat.offsetMs,
        agentId: beat.agentId,
      },
    })),
  };
}
