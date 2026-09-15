import { describe, expect, it } from 'vitest';
import { nextBestAction } from './nextAction';
import { seedLeads } from './seed';
import { stageFor } from './scoring';
import type { Lead } from './types';

const NOW = 1_700_000_000_000;
const DAY = 1000 * 60 * 60 * 24;
const book = seedLeads(400, 0x5f3a21, NOW);

const at = (score: number, over: Partial<Lead> = {}): Lead => ({
  ...book[0],
  score,
  stage: stageFor(score),
  lastEventAt: NOW,
  ...over,
});

describe('nextBestAction', () => {
  it('never recommends a touch while an agent holds the lead', () => {
    // The failure this prevents: a confident "call now" for someone an agent is
    // already calling.
    const a = nextBestAction(at(85), NOW, true);
    expect(a.emits).toBeNull();
    expect(a.label).toMatch(/wait/i);
  });

  it('recommends nothing to advance once booked', () => {
    expect(nextBestAction(at(100), NOW, false).emits).toBeNull();
  });

  it('prioritises a stale warm lead over its stage', () => {
    const fresh = nextBestAction(at(85, { lastEventAt: NOW }), NOW, false);
    const stale = nextBestAction(at(85, { lastEventAt: NOW - 30 * DAY }), NOW, false);
    expect(fresh.label).toMatch(/appointment/i);
    expect(stale.label).toMatch(/reactivate/i);
    expect(stale.urgency).toBe('high');
  });

  it('does not treat a stale COLD lead as a reactivation', () => {
    // Reactivation is for leads that were once warm. A cold lead nobody has
    // touched is just an untouched cold lead.
    const a = nextBestAction(at(5, { lastEventAt: NOW - 60 * DAY }), NOW, false);
    expect(a.label).toMatch(/first touch/i);
  });

  it('honours the lead stated contact preference', () => {
    expect(nextBestAction(at(5, { preferredContact: 'phone' }), NOW, false).label).toMatch(
      /^Call/,
    );
    expect(nextBestAction(at(5, { preferredContact: 'sms' }), NOW, false).label).toMatch(
      /^Send SMS/,
    );
    expect(nextBestAction(at(5, { preferredContact: 'email' }), NOW, false).label).toMatch(
      /^Email/,
    );
  });

  it('pushes late-funnel leads toward a booking', () => {
    for (const score of [80, 95]) {
      expect(nextBestAction(at(score), NOW, false).emits).toBe('appointment_offered');
    }
  });

  it('always returns something actionable or an explicit reason not to', () => {
    for (const lead of book) {
      for (const busy of [true, false]) {
        const a = nextBestAction(lead, NOW, busy);
        expect(a.label.length).toBeGreaterThan(0);
        expect(a.reason.length).toBeGreaterThan(0);
        if (a.emits === null) expect(a.urgency).toBe('low');
      }
    }
  });
});
