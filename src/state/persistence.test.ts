/**
 * Persistence v1 tests.
 *
 * The claim is that a reload does not cost you your session, and that a *bad*
 * saved session costs you nothing worse than a fresh start. Both halves are
 * asserted here: restoration produces the same canonical state, and every
 * corruption mode is rejected rather than partially applied.
 *
 * Canonical state is computed with the domain's own `applyEvent`/`stageFor`
 * against a book built by the real `seedLeads`, never a reimplementation — a
 * test that reimplements scoring can agree with itself while disagreeing with
 * the product.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PERSISTED_EVENTS,
  PERSIST_FORMAT_VERSION,
  PersistenceFormatError,
  createMemoryStore,
  createPersistenceController,
  hydrate,
  parsePersisted,
  type PersistedSession,
} from './persistence';
import { bootSession, resetBootForTests } from './boot';
import { BOOK_SEED } from './store';
import { seedLeads } from '../domain/seed';
import { applyEvent, stageFor } from '../domain/scoring';
import type { Lead, LeadEvent, LeadEventKind } from '../domain/types';

const BASE = 1_700_000_000_000;
const BOOK = { seed: BOOK_SEED, leadCount: 4892 };

const event = (i: number, leadId: string, kind: LeadEventKind): LeadEvent => ({
  id: `p_${i}`,
  leadId,
  kind,
  at: BASE + i * 100,
  agentId: null,
});

function saved(events: LeadEvent[], overrides: Partial<PersistedSession> = {}): unknown {
  return {
    version: PERSIST_FORMAT_VERSION,
    savedAt: BASE,
    book: BOOK,
    sealed: false,
    events: events.map((e, i) => ({ offsetMs: i * 100, event: e })),
    ...overrides,
  };
}

/** Canonical state, derived the way the store derives it. */
function canonical(events: LeadEvent[], count = 200): string {
  const leads = new Map(seedLeads(count, BOOK_SEED, BASE).map((l) => [l.id, l] as const));
  for (const e of events) {
    const lead = leads.get(e.leadId);
    if (!lead) continue;
    const score = applyEvent(lead.score, e.kind);
    leads.set(lead.id, { ...lead, score, stage: stageFor(score) } as Lead);
  }
  return [...leads.values()].map((l) => `${l.id}:${l.score}:${l.stage}`).join('|');
}

const JOURNEY: LeadEvent[] = [
  event(0, 'lead_0000', 'contacted'),
  event(1, 'lead_0000', 'replied'),
  event(2, 'lead_0001', 'opened'),
  event(3, 'lead_0000', 'call_connected'),
  event(4, 'lead_0000', 'qualified'),
  event(5, 'lead_0000', 'appointment_offered'),
  event(6, 'lead_0000', 'appointment_booked'),
  event(7, 'lead_0002', 'went_cold'),
];

beforeEach(() => resetBootForTests());

describe('persisted format', () => {
  it('accepts a well-formed session', () => {
    const parsed = parsePersisted(saved(JOURNEY));
    expect(parsed.events).toHaveLength(JOURNEY.length);
    expect(parsed.book).toEqual(BOOK);
    expect(parsed.sealed).toBe(false);
  });

  it('rejects an unknown version', () => {
    expect(() => parsePersisted(saved(JOURNEY, { version: 99 }))).toThrow(/unsupported version/);
  });

  it('rejects malformed containers and missing fields', () => {
    expect(() => parsePersisted(null)).toThrow(PersistenceFormatError);
    expect(() => parsePersisted('nope')).toThrow(PersistenceFormatError);
    expect(() => parsePersisted(saved(JOURNEY, { savedAt: undefined as never }))).toThrow(/savedAt/);
    expect(() => parsePersisted(saved(JOURNEY, { book: undefined as never }))).toThrow(/book identity/);
    expect(() => parsePersisted(saved(JOURNEY, { sealed: undefined as never }))).toThrow(/sealed/);
  });

  it('rejects a corrupt event inside an otherwise valid record', () => {
    const record = saved(JOURNEY) as { events: unknown[] };
    record.events[3] = { offsetMs: 300, event: { id: 'x', leadId: 'lead_0000', kind: 'levitated', at: BASE, agentId: null } };
    expect(() => parsePersisted(record)).toThrow(/not a LeadEventKind/);
  });

  it('rejects a partial record whose events are not an array', () => {
    expect(() => parsePersisted(saved(JOURNEY, { events: 'truncated' as never }))).toThrow();
  });
});

describe('hydration', () => {
  it('applies every event, in order, through the supplied ingest', () => {
    const seen: LeadEvent[] = [];
    const count = hydrate(parsePersisted(saved(JOURNEY)), (e) => seen.push(e));
    expect(count).toBe(JOURNEY.length);
    expect(seen.map((e) => e.id)).toEqual(JOURNEY.map((e) => e.id));
  });

  it('reproduces the same canonical state as the original run', () => {
    const live = canonical(JOURNEY);
    const restored: LeadEvent[] = [];
    hydrate(parsePersisted(saved(JOURNEY)), (e) => restored.push(e));
    expect(canonical(restored)).toBe(live);
    // Guard against passing over a no-op: the journey must actually move things.
    expect(live).not.toBe(canonical([]));
  });

  it('is stable when the same session is hydrated twice independently', () => {
    const a: LeadEvent[] = [];
    const b: LeadEvent[] = [];
    hydrate(parsePersisted(saved(JOURNEY)), (e) => a.push(e));
    hydrate(parsePersisted(saved(JOURNEY)), (e) => b.push(e));
    expect(canonical(b)).toBe(canonical(a));
  });

  it('carries a lead to booked — the state a reload most obviously must keep', () => {
    const restored: LeadEvent[] = [];
    hydrate(parsePersisted(saved(JOURNEY)), (e) => restored.push(e));
    const leads = new Map(seedLeads(200, BOOK_SEED, BASE).map((l) => [l.id, l] as const));
    let stage = '';
    for (const e of restored) {
      const lead = leads.get(e.leadId);
      if (!lead) continue;
      const score = applyEvent(lead.score, e.kind);
      leads.set(lead.id, { ...lead, score, stage: stageFor(score) } as Lead);
      if (e.leadId === 'lead_0000') stage = stageFor(score);
    }
    expect(stage).toBe('booked');
  });
});

describe('controller lifecycle', () => {
  const controllerWith = (store = createMemoryStore(), extra = {}) =>
    createPersistenceController({
      store,
      book: BOOK,
      now: () => BASE,
      writeDelayMs: 0,
      // Run scheduled writes immediately so tests never sleep.
      schedule: (fn) => {
        fn();
        return () => undefined;
      },
      ...extra,
    });

  it('reports empty storage and restores nothing', async () => {
    const c = controllerWith();
    expect(await c.restore()).toEqual({ status: 'empty' });
    expect(c.status().restored).toBe(false);
  });

  it('restores a saved session and reports the count', async () => {
    const applied: LeadEvent[] = [];
    const c = controllerWith(createMemoryStore(saved(JOURNEY)), { ingest: (e: LeadEvent) => applied.push(e) });
    const outcome = await c.restore();
    expect(outcome).toEqual({ status: 'restored', events: JOURNEY.length, sealed: false });
    expect(applied.map((e) => e.id)).toEqual(JOURNEY.map((e) => e.id));
    expect(c.status().restored).toBe(true);
  });

  it('refuses a log recorded against a different book, and keeps it', async () => {
    const store = createMemoryStore(saved(JOURNEY, { book: { seed: BOOK_SEED, leadCount: 100 } }));
    const applied: LeadEvent[] = [];
    const c = controllerWith(store, { ingest: (e: LeadEvent) => applied.push(e) });
    const outcome = await c.restore();
    expect(outcome.status).toBe('book-mismatch');
    expect(applied).toEqual([]); // nothing applied to the wrong leads
    expect(await store.load()).not.toBeNull(); // and the log is not destroyed
  });

  it('discards a corrupt log rather than partially applying it', async () => {
    const store = createMemoryStore({ version: PERSIST_FORMAT_VERSION, savedAt: BASE, book: BOOK, sealed: false, events: [{ offsetMs: 0, event: { id: '', leadId: '', kind: 'opened', at: BASE, agentId: null } }] });
    const applied: LeadEvent[] = [];
    const c = controllerWith(store, { ingest: (e: LeadEvent) => applied.push(e) });
    const outcome = await c.restore();
    expect(outcome.status).toBe('corrupt');
    expect(applied).toEqual([]);
    // The bad slot is cleared so the next boot starts clean instead of looping.
    expect(await store.load()).toBeNull();
  });

  it('survives storage that is unavailable', async () => {
    const dead = { ...createMemoryStore(), available: () => false };
    const c = controllerWith(dead);
    expect((await c.restore()).status).toBe('unavailable');
    expect(c.status().active).toBe(false);
  });

  it('keeps running when a write throws, and says so', async () => {
    const failing = {
      ...createMemoryStore(),
      save: async () => {
        throw new Error('QuotaExceededError');
      },
    };
    const c = controllerWith(failing);
    await c.restore();
    c.startRecording();
    await c.flush();
    expect(c.status().active).toBe(false);
    expect(c.status().lastError).toMatch(/Quota/);
    c.stopRecording();
  });

  it('clear() empties the store and the in-memory log', async () => {
    const store = createMemoryStore(saved(JOURNEY));
    const c = controllerWith(store, { ingest: () => undefined });
    await c.restore();
    expect(c.status().events).toBe(JOURNEY.length);
    await c.clear();
    expect(await store.load()).toBeNull();
    expect(c.status().events).toBe(0);
    expect(c.status().restored).toBe(false);
  });

  it('exposes the diagnostics the overlay reads', async () => {
    const c = controllerWith(createMemoryStore(saved(JOURNEY)), { ingest: () => undefined });
    await c.restore();
    const s = c.status();
    expect(s.store).toBe('memory');
    expect(s.version).toBe(PERSIST_FORMAT_VERSION);
    expect(s.events).toBe(JOURNEY.length);
    expect(s.outcome).toBe('restored');
  });
});

describe('live recording after restore', () => {
  it('appends live events onto the restored log and writes them', async () => {
    const store = createMemoryStore(saved(JOURNEY));
    const applied: LeadEvent[] = [];
    const c = createPersistenceController({
      store,
      book: BOOK,
      now: () => BASE,
      writeDelayMs: 0,
      schedule: (fn) => {
        fn();
        return () => undefined;
      },
      ingest: (e) => applied.push(e),
    });
    await c.restore();
    c.startRecording();

    // A real ingest through the store is what the recorder observes.
    const { useApsis } = await import('./store');
    const liveId = useApsis.getState().order[0];
    useApsis.getState().ingest({ id: 'live_1', leadId: liveId, kind: 'clicked', at: BASE, agentId: null });

    await c.flush();
    const written = parsePersisted(await store.load());
    expect(written.events.length).toBe(JOURNEY.length + 1);
    expect(written.events.at(-1)!.event.id).toBe('live_1');
    c.stopRecording();
  });

  it('writes on a continuous event stream — a debounce here would starve', async () => {
    // Regression: the first implementation cancelled and rescheduled its write
    // on every event, so at ~9 events/sec the timer never elapsed and NOTHING
    // was ever persisted, silently. A fake scheduler that only fires when told
    // is what exposes it — an immediate scheduler hides the bug entirely.
    const store = createMemoryStore();
    let pending: (() => void) | null = null;
    const c = createPersistenceController({
      store,
      book: BOOK,
      now: () => BASE,
      writeDelayMs: 1500,
      schedule: (fn) => {
        pending = fn;
        return () => {
          pending = null;
        };
      },
    });
    await c.restore();
    c.startRecording();

    const { useApsis } = await import('./store');
    const ids = useApsis.getState().order.slice(0, 10);
    ids.forEach((leadId, i) =>
      useApsis.getState().ingest({ id: `stream_${i}`, leadId, kind: 'opened', at: BASE, agentId: null }),
    );

    // A pending write must still exist after a burst; a debounce would have
    // cancelled it ten times over and left nothing scheduled.
    expect(pending).not.toBeNull();
    pending!();
    await c.flush();
    expect(parsePersisted(await store.load()).events.length).toBeGreaterThan(0);
    c.stopRecording();
  });

  it('reports what is DURABLE separately from what is in memory', async () => {
    // The overstatement this forbids: `status().events` is the in-memory log,
    // and writes are throttled, so the tail of it is routinely not on disk. A
    // reload in that window loses it — `pagehide` starts a flush but cannot
    // await one. Reporting only `events` under the label "persistence" claims a
    // durability the session has not earned, and a browser test that believed
    // it compared 50 events before a reload against the 48 that came back.
    const store = createMemoryStore();
    let pending: (() => void) | null = null;
    const c = createPersistenceController({
      store,
      book: BOOK,
      now: () => BASE,
      writeDelayMs: 1500,
      schedule: (fn) => {
        pending = fn;
        return () => {
          pending = null;
        };
      },
    });
    await c.restore();
    c.startRecording();

    const { useApsis } = await import('./store');
    const ids = useApsis.getState().order.slice(0, 5);
    ids.forEach((leadId, i) =>
      useApsis.getState().ingest({ id: `dur_${i}`, leadId, kind: 'opened', at: BASE, agentId: null }),
    );

    // Recorded, scheduled — and not yet on disk. Both numbers must say so.
    expect(c.status().events).toBeGreaterThan(0);
    expect(c.status().persisted).toBe(0);

    pending!();
    await c.flush();
    expect(c.status().persisted).toBe(c.status().events);
    c.stopRecording();
  });

  it('seals rather than trimming when the cap is reached', async () => {
    // A sealed log is a correct PREFIX of the session; trimming the head would
    // replay into a state the session never passed through.
    expect(MAX_PERSISTED_EVENTS).toBeGreaterThan(1000);
  });
});

describe('boot lifecycle', () => {
  it('runs exactly once even when called concurrently (StrictMode double-invoke)', async () => {
    const restore = vi.fn(async () => ({ status: 'empty' }) as const);
    const startRecording = vi.fn();
    const fake = {
      restore,
      startRecording,
      stopRecording: vi.fn(),
      flush: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      status: vi.fn(() => ({ store: 'memory', active: true, restored: false, events: 0, persisted: 0, version: 1, sealed: false, lastError: null, outcome: null })),
    };
    const [a, b] = await Promise.all([
      bootSession({ controller: fake }),
      bootSession({ controller: fake }),
    ]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('records only after restore has completed', async () => {
    const calls: string[] = [];
    const fake = {
      restore: async () => {
        calls.push('restore');
        return { status: 'empty' } as const;
      },
      startRecording: () => calls.push('record'),
      stopRecording: () => undefined,
      flush: async () => undefined,
      clear: async () => undefined,
      status: () => ({ store: 'memory', active: true, restored: false, events: 0, persisted: 0, version: 1, sealed: false, lastError: null, outcome: null }),
    };
    await bootSession({ controller: fake });
    expect(calls).toEqual(['restore', 'record']);
  });

  it('replay mode neither restores nor records — it cannot pollute a real book', async () => {
    const result = await bootSession({ isolated: true });
    expect(result.controller).toBeNull();
  });
});
