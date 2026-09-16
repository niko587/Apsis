/**
 * Replay source tests.
 *
 * The claim under test is architectural, not cosmetic: that Apsis can swap the
 * thing producing events without anything above the seam changing. So these
 * assert the properties that claim depends on — order, timing, determinism,
 * clean shutdown, and rejection of data that would replay a *plausible* but
 * wrong session.
 *
 * Determinism is asserted against the domain's own `applyEvent`/`stageFor`
 * rather than a reimplementation, and against a book built by the real
 * `seedLeads`. Duplicating the scoring rules here would let the test agree with
 * itself while disagreeing with the product.
 */

import { describe, expect, it } from 'vitest';
import {
  ReplayFormatError,
  createManualClock,
  createReplaySource,
  createSessionRecorder,
  deserializeSession,
  parseSession,
  serializeSession,
  REPLAY_FORMAT_VERSION,
  type ReplaySession,
} from './replay';
import { demoSession } from './fixtures/demoSession';
import { createSimulatedSource } from './source';
import { seedAgents, seedLeads } from '../domain/seed';
import { applyEvent, stageFor } from '../domain/scoring';
import type { Lead, LeadEvent } from '../domain/types';
import { useApsis } from './store';

/** Fixed base so every assertion below is clock-independent. */
const BASE = 1_700_000_000_000;

/** Drive a session through the domain the same way `ingest` does. */
function applySessionToBook(session: ReplaySession, book: Lead[]): Map<string, Lead> {
  const leads = new Map(book.map((l) => [l.id, l]));
  for (const { event } of session.events) {
    const lead = leads.get(event.leadId);
    if (!lead) continue;
    const score = applyEvent(lead.score, event.kind);
    leads.set(lead.id, { ...lead, score, stage: stageFor(score), lastEventAt: event.at });
  }
  return leads;
}

const collect = (session: ReplaySession, clock = createManualClock()) => {
  const seen: LeadEvent[] = [];
  const source = createReplaySource(session, {
    ingest: (e) => seen.push(e),
    schedule: clock.schedule,
  });
  return { seen, source, clock };
};

describe('replay session format', () => {
  it('round-trips through serialize/deserialize unchanged', () => {
    const session = demoSession(BASE);
    const back = deserializeSession(serializeSession(session));
    expect(back).toEqual(session);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseSession({ ...demoSession(BASE), version: 99 })).toThrow(ReplayFormatError);
  });

  it('rejects a non-object session and malformed JSON', () => {
    expect(() => parseSession(null)).toThrow(ReplayFormatError);
    expect(() => parseSession([])).toThrow(ReplayFormatError);
    expect(() => deserializeSession('{oops')).toThrow(ReplayFormatError);
  });

  it('rejects an event kind the domain does not define', () => {
    const bad = {
      version: REPLAY_FORMAT_VERSION,
      name: 'bad',
      recordedAt: null,
      events: [{ offsetMs: 0, event: { id: 'e', leadId: 'lead_0000', kind: 'teleported', at: BASE, agentId: null } }],
    };
    expect(() => parseSession(bad)).toThrow(/not a LeadEventKind/);
  });

  it('rejects offsets that are negative or go backwards', () => {
    const negative = {
      version: REPLAY_FORMAT_VERSION, name: 'n', recordedAt: null,
      events: [{ offsetMs: -1, event: { id: 'e', leadId: 'lead_0000', kind: 'opened', at: BASE, agentId: null } }],
    };
    expect(() => parseSession(negative)).toThrow(/offsetMs/);

    const backwards = {
      version: REPLAY_FORMAT_VERSION, name: 'n', recordedAt: null,
      events: [
        { offsetMs: 10, event: { id: 'a', leadId: 'lead_0000', kind: 'opened', at: BASE, agentId: null } },
        { offsetMs: 5, event: { id: 'b', leadId: 'lead_0000', kind: 'clicked', at: BASE, agentId: null } },
      ],
    };
    expect(() => parseSession(backwards)).toThrow(/goes backwards/);
  });

  it('rejects a missing or malformed event payload', () => {
    const noLead = {
      version: REPLAY_FORMAT_VERSION, name: 'n', recordedAt: null,
      events: [{ offsetMs: 0, event: { id: 'e', leadId: '', kind: 'opened', at: BASE, agentId: null } }],
    };
    expect(() => parseSession(noLead)).toThrow(/leadId/);
  });
});

describe('built-in fixture', () => {
  it('is valid replay data and uses only real domain vocabulary', () => {
    const session = demoSession(BASE);
    expect(() => parseSession(session)).not.toThrow();
    expect(session.events.length).toBeGreaterThan(5);

    // Every agentId must be an agent that actually exists, or null.
    const agentIds = new Set(seedAgents().map((a) => a.id));
    const referenced = session.events.map((e) => e.event.agentId).filter((a): a is string => a !== null);
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) expect(agentIds.has(id)).toBe(true);
  });

  it('references leads that exist in the seeded book', () => {
    const ids = new Set(seedLeads(100, 0x5f3a21, BASE).map((l) => l.id));
    for (const { event } of demoSession(BASE).events) expect(ids.has(event.leadId)).toBe(true);
  });

  it('carries one lead all the way to booked, which is the only route to periapsis', () => {
    const session = demoSession(BASE);
    const leads = applySessionToBook(session, seedLeads(100, 0x5f3a21, BASE));
    expect(leads.get('lead_0000')!.stage).toBe('booked');
    // …and another the other way, so the fixture is not uniformly optimistic.
    expect(leads.get('lead_0001')!.score).toBeLessThan(leads.get('lead_0000')!.score);
  });
});

describe('replay source', () => {
  it('emits every event, in recorded order', () => {
    const session = demoSession(BASE);
    const { seen, source, clock } = collect(session);
    source.start();
    clock.advance(60_000);
    expect(seen.map((e) => e.id)).toEqual(session.events.map((r) => r.event.id));
  });

  it('preserves recorded relative timing', () => {
    const session = demoSession(BASE);
    const clock = createManualClock();
    const stamps: number[] = [];
    const source = createReplaySource(session, {
      ingest: () => stamps.push(clock.now()),
      schedule: clock.schedule,
    });
    source.start();
    clock.advance(60_000);
    expect(stamps).toEqual(session.events.map((r) => r.offsetMs));
  });

  it('honours a speed multiplier without changing order', () => {
    const session = demoSession(BASE);
    const clock = createManualClock();
    const stamps: number[] = [];
    const source = createReplaySource(session, {
      ingest: () => stamps.push(clock.now()),
      schedule: clock.schedule,
      speed: 2,
    });
    source.start();
    clock.advance(60_000);
    expect(stamps).toEqual(session.events.map((r) => r.offsetMs / 2));
  });

  it('emits nothing after stop, including an already-scheduled tick', () => {
    const session = demoSession(BASE);
    const { seen, source, clock } = collect(session);
    source.start();
    clock.advance(3_000);
    const delivered = seen.length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(session.events.length);

    source.stop();
    clock.advance(60_000);
    expect(seen.length).toBe(delivered);
    expect(clock.pending()).toBe(0);
  });

  it('is inert for an empty session and ignores a double start', () => {
    const empty: ReplaySession = { version: REPLAY_FORMAT_VERSION, name: 'empty', recordedAt: null, events: [] };
    const { seen, source, clock } = collect(empty);
    source.start();
    clock.advance(1000);
    expect(seen).toEqual([]);

    const session = demoSession(BASE);
    const second = collect(session);
    second.source.start();
    second.source.start();
    second.clock.advance(60_000);
    expect(second.seen.length).toBe(session.events.length);
  });

  it('validates its session at construction, not halfway through playback', () => {
    expect(() => createReplaySource({ ...demoSession(BASE), version: 7 })).toThrow(ReplayFormatError);
  });

  it('identifies itself for diagnostics', () => {
    expect(createReplaySource(demoSession(BASE)).name).toContain('replay');
    expect(createSimulatedSource().name).toBe('simulator');
  });
});

describe('determinism', () => {
  it('delivers an identical sequence on two independent runs', () => {
    const session = demoSession(BASE);
    const first = collect(session);
    first.source.start();
    first.clock.advance(60_000);

    const second = collect(session);
    second.source.start();
    second.clock.advance(60_000);

    expect(second.seen).toEqual(first.seen);
  });

  it('produces identical canonical state from the same initial book', () => {
    const session = demoSession(BASE);
    const a = applySessionToBook(session, seedLeads(500, 0x5f3a21, BASE));
    const b = applySessionToBook(session, seedLeads(500, 0x5f3a21, BASE));

    const canonical = (m: Map<string, Lead>) =>
      [...m.values()].map((l) => `${l.id}:${l.score}:${l.stage}`).join('|');
    expect(canonical(b)).toBe(canonical(a));

    // And the session actually moved something — a determinism test over a
    // no-op would pass while proving nothing.
    const untouched = applySessionToBook(
      { ...session, events: [] },
      seedLeads(500, 0x5f3a21, BASE),
    );
    expect(canonical(a)).not.toBe(canonical(untouched));
  });

  it('a truncated replay is a prefix of the full one, never a different run', () => {
    const session = demoSession(BASE);
    const partial = collect(session);
    partial.source.start();
    partial.clock.advance(5_000);
    partial.source.stop();

    const full = collect(session);
    full.source.start();
    full.clock.advance(60_000);

    expect(full.seen.slice(0, partial.seen.length)).toEqual(partial.seen);
  });
});

describe('record → serialize → replay composes', () => {
  it('replays a recorded session into the same canonical state', () => {
    // Record whatever the store actually ingests, by driving `ingest` directly.
    let fakeNow = BASE;
    const recorder = createSessionRecorder({ name: 'roundtrip', now: () => fakeNow });
    recorder.start();

    const order = useApsis.getState().order.slice(0, 3);
    const script: Array<[string, LeadEvent['kind']]> = [
      [order[0], 'contacted'],
      [order[1], 'opened'],
      [order[0], 'replied'],
      [order[2], 'clicked'],
      [order[0], 'qualified'],
    ];
    script.forEach(([leadId, kind], i) => {
      fakeNow = BASE + i * 250;
      useApsis.getState().ingest({ id: `rt_${i}`, leadId, kind, at: fakeNow, agentId: null });
    });
    recorder.stop();

    const recorded = recorder.session();
    expect(recorded.events.map((r) => r.event.id)).toEqual(script.map((_, i) => `rt_${i}`));
    expect(recorded.events.map((r) => r.offsetMs)).toEqual([0, 250, 500, 750, 1000]);

    // Survive a trip through the wire format…
    const reloaded = deserializeSession(serializeSession(recorded));
    expect(reloaded).toEqual(recorded);

    // …and replay into a *fresh* book, reaching the same canonical state as
    // applying the original script to that same book.
    const replayed = applySessionToBook(reloaded, seedLeads(50, 0x5f3a21, BASE));
    const expected = applySessionToBook(recorded, seedLeads(50, 0x5f3a21, BASE));
    const canonical = (m: Map<string, Lead>) =>
      [...m.values()].map((l) => `${l.id}:${l.score}:${l.stage}`).join('|');
    expect(canonical(replayed)).toBe(canonical(expected));
  });

  it('records nothing once stopped', () => {
    const recorder = createSessionRecorder({ now: () => BASE });
    recorder.start();
    recorder.stop();
    const before = recorder.session().events.length;
    const id = useApsis.getState().order[0];
    useApsis.getState().ingest({ id: 'after_stop', leadId: id, kind: 'opened', at: BASE, agentId: null });
    expect(recorder.session().events.length).toBe(before);
  });
});

describe('the simulator is unaffected', () => {
  it('still conforms to the contract and starts/stops cleanly', () => {
    const sim = createSimulatedSource({ eventsPerSecond: 9 });
    expect(typeof sim.start).toBe('function');
    expect(typeof sim.stop).toBe('function');
    expect(sim.name).toBe('simulator');
    // stop() before start() must not throw — App unmounts can reach it.
    expect(() => sim.stop()).not.toThrow();
  });
});
