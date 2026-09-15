import { describe, expect, it } from 'vitest';
import { STAGES, STAGE_ORDER } from './types';
import { applyEvent, decayedScore, stageFor } from './scoring';
import { APOAPSIS, PERIAPSIS, radiusFor, scoreAtRadius, positionFor } from './gravity';
import { AGENT_FOR, agentFor, isAgentDriven } from './agents';
import { seedAgents } from './seed';

describe('stage bands', () => {
  it('tile 0..100 over the reals, with no gap and no overlap', () => {
    const bands = STAGE_ORDER.map((id) => STAGES[id]);
    expect(bands[0].lo).toBe(0);
    expect(bands[bands.length - 1].hi).toBe(100);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].lo).toBe(bands[i - 1].hi);
    }
  });

  it('assigns every score to exactly one stage, fractions included', () => {
    // Stepping by 0.25 is the point: integer-only coverage is what hid the
    // original band gap at 20.5.
    for (let s = 0; s <= 100; s += 0.25) {
      const spec = STAGES[stageFor(s)];
      expect(s).toBeGreaterThanOrEqual(spec.lo);
      expect(s).toBeLessThanOrEqual(spec.hi);
      if (s < 100) expect(s).toBeLessThan(spec.hi);
    }
  });
});

describe('gravity', () => {
  it('puts score 0 at apoapsis and score 100 at periapsis', () => {
    expect(radiusFor(0)).toBeCloseTo(APOAPSIS, 6);
    expect(radiusFor(100)).toBeCloseTo(PERIAPSIS, 6);
  });

  it('is monotonically inward — more score is never further out', () => {
    let prev = Infinity;
    for (let s = 0; s <= 100; s += 0.5) {
      const r = radiusFor(s);
      expect(r).toBeLessThanOrEqual(prev + 1e-9);
      prev = r;
    }
  });

  it('round-trips radius back to score', () => {
    for (const s of [0, 7, 23, 41, 66, 83, 94, 100]) {
      expect(scoreAtRadius(radiusFor(s))).toBeCloseTo(s, 4);
    }
  });

  it('gives every stage a visible annulus', () => {
    // The point of the stage-indexed journey: no stage may collapse to a sliver,
    // even though the score bands themselves are uneven.
    const widths = STAGE_ORDER.map((id) => {
      const { lo, hi } = STAGES[id];
      return radiusFor(lo) - radiusFor(hi - 0.0001);
    });
    for (const w of widths) expect(w).toBeGreaterThan(0.4);
  });

  it('keeps a lead on its own angular line as it travels inward', () => {
    const lead = { theta: 1.1, inclination: 0.3 };
    const cold = positionFor({ ...lead, score: 5 });
    const hot = positionFor({ ...lead, score: 85 });
    // Same bearing from the axis, different distance.
    expect(Math.atan2(cold.z, cold.x)).toBeCloseTo(Math.atan2(hot.z, hot.x), 6);
    expect(Math.hypot(hot.x, hot.z)).toBeLessThan(Math.hypot(cold.x, cold.z));
  });

  it('flattens the disc toward the appointment ring', () => {
    const lead = { theta: 0.4, inclination: 0.6 };
    expect(Math.abs(positionFor({ ...lead, score: 100 }).y)).toBeLessThan(
      Math.abs(positionFor({ ...lead, score: 0 }).y),
    );
  });
});

describe('scoring', () => {
  it('clamps to 0..100', () => {
    expect(applyEvent(2, 'went_cold')).toBe(0);
    expect(applyEvent(97, 'appointment_booked')).toBe(100);
    expect(applyEvent(50, 'unsubscribed')).toBe(0);
  });

  it('cannot be talked to 100 by touches alone — booking is required', () => {
    let score = 0;
    for (let i = 0; i < 200; i++) score = applyEvent(score, 'replied');
    expect(score).toBeLessThan(100);
    expect(stageFor(score)).not.toBe('booked');
    expect(stageFor(applyEvent(score, 'appointment_booked'))).toBe('booked');
  });

  it('moves leads back outward on negative events', () => {
    const before = 80;
    expect(applyEvent(before, 'objection')).toBeLessThan(before);
    expect(applyEvent(before, 'appointment_cancelled')).toBeLessThan(before);
    expect(radiusFor(applyEvent(before, 'objection'))).toBeGreaterThan(radiusFor(before));
  });

  it('is deterministic for a given event sequence', () => {
    const seq = ['contacted', 'opened', 'replied', 'objection', 'qualified'] as const;
    const run = () => seq.reduce((s, k) => applyEvent(s, k), 0);
    expect(run()).toBe(run());
  });
});

describe('decay', () => {
  const DAY = 1000 * 60 * 60 * 24;

  it('leaves recently touched leads alone', () => {
    const now = 1_700_000_000_000;
    expect(decayedScore(60, now - DAY, now)).toBe(60);
  });

  it('cools idle leads', () => {
    const now = 1_700_000_000_000;
    expect(decayedScore(60, now - 10 * DAY, now)).toBeLessThan(60);
  });

  it('never cools a booked appointment', () => {
    const now = 1_700_000_000_000;
    expect(decayedScore(100, now - 400 * DAY, now)).toBe(100);
  });
});

describe('agent routing', () => {
  const lead = (id: string, score: number) =>
    ({ id, score }) as unknown as import('./types').Lead;

  it('routes every agent-driven event to some agent', () => {
    const kinds = Object.keys(AGENT_FOR) as Array<keyof typeof AGENT_FOR>;
    for (const k of kinds) {
      if (!isAgentDriven(k)) continue;
      expect(agentFor(k, lead('lead_0001', 50))).toBeTruthy();
    }
  });

  it('leaves no agent in the roster unreachable', () => {
    // The regression this guards: `agent_email` and `agent_reactivation` were
    // rostered and rendered but no event could ever route to them, so they were
    // permanently idle.
    const reachable = new Set<string>();
    const kinds = Object.keys(AGENT_FOR) as Array<keyof typeof AGENT_FOR>;
    for (let i = 0; i < 400; i++) {
      const l = lead(`lead_${i.toString(36).padStart(4, '0')}`, (i % 100) + 0.5);
      for (const k of kinds) {
        const a = agentFor(k, l);
        if (a) reachable.add(a);
      }
    }
    for (const agent of seedAgents()) {
      expect(reachable, `${agent.id} is never assigned work`).toContain(agent.id);
    }
  });

  it('keeps a lead on a stable outreach channel', () => {
    const l = lead('lead_00zz', 10);
    expect(agentFor('contacted', l)).toBe(agentFor('contacted', l));
  });

  it('sends lapsed leads to reactivation, routine ones to follow-up', () => {
    expect(agentFor('went_cold', lead('lead_0001', 5))).toBe('agent_follow_up');
    expect(agentFor('went_cold', lead('lead_0001', 70))).toBe('agent_reactivation');
  });
});
