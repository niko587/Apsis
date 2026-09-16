import { describe, expect, it } from 'vitest';
import type { AgentTask, Lead, LeadEvent } from '../domain/types';
import { SETTLE_MS, SKILLS, deriveSkills } from './skills';

const NOW = 1_700_000_000_000;

const lead = (id: string, name: string): Lead => ({
  id,
  name,
  company: null,
  location: 'Tampa, FL',
  segment: 'Family Coverage',
  campaign: 'Open Enrollment',
  acquisitionSource: 'Referral',
  score: 50,
  stage: 'engaged',
  theta: 0,
  inclination: 0,
  lastEventAt: NOW,
  createdAt: NOW,
  appointmentAt: null,
  ownerAgentId: null,
  phone: '(813) 555-0100',
  email: `${id}@example.com`,
  age: 42,
  occupation: 'Teacher',
  currentCoverage: null,
  preferredContact: 'sms',
  needs: [],
  intent: 0.5,
});

const leads = new Map<string, Lead>([
  ['lead_a', lead('lead_a', 'Sarah Martinez')],
  ['lead_b', lead('lead_b', 'Mike Chen')],
]);

const task = (id: string, agentId: string, leadId: string, emits: AgentTask['emits']): AgentTask => ({
  id,
  agentId,
  leadId,
  startedAt: NOW - 500,
  dueAt: NOW + 1500,
  emits,
});

const event = (agentId: string | null, kind: LeadEvent['kind'], at: number, leadId = 'lead_a'): LeadEvent => ({
  id: `evt_${agentId}_${kind}_${at}`,
  leadId,
  kind,
  at,
  agentId,
});

describe('active skills derivation (§12)', () => {
  it('shows NOTHING when nothing is happening — never the full skill list', () => {
    expect(deriveSkills(new Map(), [], leads, NOW)).toEqual([]);
  });

  it('an in-flight task makes exactly its skill EXECUTING, naming the lead', () => {
    const tasks = new Map([
      ['t1', task('t1', 'agent_qualification', 'lead_a', 'qualified')],
    ]);
    const out = deriveSkills(tasks, [], leads, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'skill_qualification',
      status: 'EXECUTING',
      detail: 'analyzing Sarah Martinez',
      until: Infinity,
    });
  });

  it('several tasks on one skill aggregate into a count', () => {
    const tasks = new Map([
      ['t1', task('t1', 'agent_sms', 'lead_a', 'contacted')],
      ['t2', task('t2', 'agent_sms', 'lead_b', 'contacted')],
    ]);
    const out = deriveSkills(tasks, [], leads, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'skill_sms', detail: 'working 2 leads', count: 2 });
  });

  it('a just-resolved task shows COMPLETE with an expiry, then disappears', () => {
    const feed = [event('agent_booking', 'appointment_booked', NOW - 1000)];
    const out = deriveSkills(new Map(), feed, leads, NOW);
    const booking = out.find((s) => s.id === 'skill_booking');
    expect(booking).toMatchObject({
      status: 'COMPLETE',
      detail: 'booked Sarah Martinez',
      until: NOW - 1000 + SETTLE_MS,
    });
    // Same facts, read after the settle window: the entry is gone.
    const later = deriveSkills(new Map(), feed, leads, NOW + SETTLE_MS + 1);
    expect(later.find((s) => s.id === 'skill_booking')).toBeUndefined();
  });

  it('a failure outcome reads as ERROR, not COMPLETE', () => {
    const feed = [event('agent_call', 'call_no_answer', NOW - 500)];
    const out = deriveSkills(new Map(), feed, leads, NOW);
    expect(out.find((s) => s.id === 'skill_call')).toMatchObject({
      status: 'ERROR',
      detail: 'no answer from Sarah Martinez',
    });
  });

  it('inbound events make Lead Intelligence ACTIVE, counting distinct leads', () => {
    const feed = [
      event(null, 'replied', NOW - 1000, 'lead_a'),
      event(null, 'opened', NOW - 2000, 'lead_b'),
      event(null, 'clicked', NOW - 3000, 'lead_a'), // same lead — not double counted
    ];
    const out = deriveSkills(new Map(), feed, leads, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'skill_intelligence',
      status: 'ACTIVE',
      detail: 'scoring 2 leads',
    });
  });

  it('every emitted status is one of the five §12 allows', () => {
    const allowed = new Set(['READY', 'ACTIVE', 'EXECUTING', 'COMPLETE', 'ERROR']);
    const tasks = new Map([
      ['t1', task('t1', 'agent_call', 'lead_a', 'call_connected')],
    ]);
    const feed = [
      event('agent_sms', 'contacted', NOW - 1000, 'lead_b'),
      event(null, 'replied', NOW - 2000),
    ];
    for (const s of deriveSkills(tasks, feed, leads, NOW)) {
      expect(allowed.has(s.status)).toBe(true);
    }
  });

  it('covers every agent in the roster — no skill can be orphaned', () => {
    const agentIds = new Set(SKILLS.map((s) => s.agentId).filter(Boolean));
    for (const kind of ['call', 'sms', 'email', 'follow_up', 'qualification', 'booking', 'reactivation']) {
      expect(agentIds.has(`agent_${kind}`)).toBe(true);
    }
  });
});
