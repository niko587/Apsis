/**
 * Replay: the second concrete implementation of the source contract.
 *
 * WHY THIS EXISTS
 * Everything above `source.ts` is real and test-covered; below it there was one
 * implementation, which means the "seam" was a claim rather than a fact. A
 * second source that reaches the same place by a different route is the only
 * way to find out whether the abstraction is genuine. This is that source — not
 * a mock, not a demo mode: it produces real `LeadEvent`s and hands them to the
 * same `ingest` the simulator uses.
 *
 * THE ONE RULE IT OBEYS
 * `ingest(event)` remains the only way incoming events change state. Replay
 * touches no store field directly, knows nothing about zustand, React, Three.js
 * or the Universe, and could be pointed at a CRM webhook payload tomorrow
 * without anything above the seam noticing.
 *
 * WHAT REPLAY DOES *NOT* REPRODUCE, stated plainly
 * The simulator does two things beyond emitting events: it opens `AgentTask`s
 * (which is what draws the in-flight agent arcs) and it drives `applyDecay` on a
 * timer. Neither is a domain event, so neither is recorded. A replayed session
 * therefore reproduces lead scores, stages, positions, appointments and the
 * activity feed exactly, but not the transient agent arcs that were in flight
 * while it was recorded. Each replayed event still carries its original
 * `agentId`, so attribution survives; only the in-flight animation does not.
 * Decay is a pure function of elapsed wall-clock time with a 72h grace period,
 * so it is a no-op across any session short enough to record.
 */

import type { LeadEvent, LeadEventKind } from '../domain/types';
import { useApsis } from './store';
import type { LeadSource } from './source';

/** Bumped only on a breaking change to the on-disk shape. */
export const REPLAY_FORMAT_VERSION = 1;

/** Every event kind the domain actually defines. Used to validate replay data. */
const KINDS: ReadonlySet<string> = new Set<LeadEventKind>([
  'ingested',
  'contacted',
  'opened',
  'clicked',
  'replied',
  'call_connected',
  'call_no_answer',
  'qualified',
  'objection',
  'appointment_offered',
  'appointment_booked',
  'appointment_cancelled',
  'went_cold',
  'unsubscribed',
]);

export interface RecordedEvent {
  /**
   * Milliseconds from the start of the recording.
   *
   * Relative rather than absolute so a session can be replayed at any time, at
   * any speed, without rewriting the events themselves. The event keeps its own
   * `at`, which is domain data.
   */
  readonly offsetMs: number;
  readonly event: LeadEvent;
}

export interface ReplaySession {
  readonly version: number;
  /** Human label for diagnostics — never load-bearing. */
  readonly name: string;
  /** Wall clock when recording began, or null for an authored fixture. */
  readonly recordedAt: number | null;
  readonly events: readonly RecordedEvent[];
}

export class ReplayFormatError extends Error {
  constructor(message: string) {
    super(`replay: ${message}`);
    this.name = 'ReplayFormatError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate untrusted replay data into a `ReplaySession`.
 *
 * Throws rather than returning a partial session: a replay that silently drops
 * malformed events would produce a *plausible* run that does not match what was
 * recorded, which is worse than a loud failure — the whole value of this path is
 * that the output is trustworthy.
 */
export function parseSession(raw: unknown): ReplaySession {
  if (!isRecord(raw)) throw new ReplayFormatError('session must be an object');
  if (raw.version !== REPLAY_FORMAT_VERSION) {
    throw new ReplayFormatError(
      `unsupported version ${String(raw.version)} (expected ${REPLAY_FORMAT_VERSION})`,
    );
  }
  if (!Array.isArray(raw.events)) throw new ReplayFormatError('events must be an array');
  if (raw.recordedAt !== null && typeof raw.recordedAt !== 'number') {
    throw new ReplayFormatError('recordedAt must be a number or null');
  }

  let previousOffset = -1;
  const events: RecordedEvent[] = raw.events.map((entry, i) => {
    if (!isRecord(entry)) throw new ReplayFormatError(`events[${i}] must be an object`);
    const { offsetMs, event } = entry;
    if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || offsetMs < 0) {
      throw new ReplayFormatError(`events[${i}].offsetMs must be a finite number >= 0`);
    }
    // Monotonic offsets are what make "deterministic order" and "recorded
    // timing" the same statement; out-of-order data would replay differently
    // from how it was captured.
    if (offsetMs < previousOffset) {
      throw new ReplayFormatError(
        `events[${i}].offsetMs (${offsetMs}) goes backwards from ${previousOffset}`,
      );
    }
    previousOffset = offsetMs;

    if (!isRecord(event)) throw new ReplayFormatError(`events[${i}].event must be an object`);
    if (typeof event.id !== 'string' || event.id === '') {
      throw new ReplayFormatError(`events[${i}].event.id must be a non-empty string`);
    }
    if (typeof event.leadId !== 'string' || event.leadId === '') {
      throw new ReplayFormatError(`events[${i}].event.leadId must be a non-empty string`);
    }
    if (typeof event.kind !== 'string' || !KINDS.has(event.kind)) {
      throw new ReplayFormatError(`events[${i}].event.kind "${String(event.kind)}" is not a LeadEventKind`);
    }
    if (typeof event.at !== 'number' || !Number.isFinite(event.at)) {
      throw new ReplayFormatError(`events[${i}].event.at must be a finite number`);
    }
    if (event.agentId !== null && typeof event.agentId !== 'string') {
      throw new ReplayFormatError(`events[${i}].event.agentId must be a string or null`);
    }
    return {
      offsetMs,
      event: {
        id: event.id,
        leadId: event.leadId,
        kind: event.kind as LeadEventKind,
        at: event.at,
        agentId: event.agentId as string | null,
        ...(typeof event.note === 'string' ? { note: event.note } : {}),
      },
    };
  });

  return {
    version: REPLAY_FORMAT_VERSION,
    name: typeof raw.name === 'string' ? raw.name : 'replay',
    recordedAt: (raw.recordedAt as number | null) ?? null,
    events,
  };
}

export const serializeSession = (session: ReplaySession): string =>
  JSON.stringify(session, null, 2);

export const deserializeSession = (json: string): ReplaySession => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ReplayFormatError('not valid JSON');
  }
  return parseSession(raw);
};

/* -------------------------------------------------------------- recording --- */

export interface RecorderOptions {
  name?: string;
  /** Injectable clock so a recording can be made without wall-clock flakiness. */
  now?: () => number;
}

export interface SessionRecorder {
  start(): void;
  stop(): void;
  session(): ReplaySession;
}

/**
 * Record every event that passes through `ingest`, by observing the store's
 * own feed rather than by wrapping the store.
 *
 * The feed is newest-first and one entry is added per ingested event, so
 * watching its head captures the canonical stream regardless of which route an
 * event took to get there — inbound from the simulator, or emitted by an agent
 * task completing. Wrapping `ingest` would have captured the same events while
 * adding a second thing that can mutate state; observing does not.
 */
export function createSessionRecorder(options: RecorderOptions = {}): SessionRecorder {
  const { name = 'recorded', now = Date.now } = options;
  const events: RecordedEvent[] = [];
  let startedAt: number | null = null;
  let lastSeenId: string | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    start() {
      if (unsubscribe) return;
      startedAt = now();
      lastSeenId = useApsis.getState().feed[0]?.id ?? null;
      unsubscribe = useApsis.subscribe((state) => {
        const head = state.feed[0];
        if (!head || head.id === lastSeenId) return;
        // Walk back to the last event already recorded, then replay forwards so
        // the recording keeps the order the store saw.
        const fresh: LeadEvent[] = [];
        for (const event of state.feed) {
          if (event.id === lastSeenId) break;
          fresh.push(event);
        }
        lastSeenId = head.id;
        const offsetMs = Math.max(0, now() - (startedAt ?? 0));
        for (let i = fresh.length - 1; i >= 0; i--) events.push({ offsetMs, event: fresh[i] });
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
    session() {
      return {
        version: REPLAY_FORMAT_VERSION,
        name,
        recordedAt: startedAt,
        events: [...events],
      };
    },
  };
}

/* ----------------------------------------------------------- replay source --- */

/** Schedules `fn` after `delayMs`; the returned function cancels it. */
export type Scheduler = (fn: () => void, delayMs: number) => () => void;

const timeoutScheduler: Scheduler = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs);
  return () => clearTimeout(id);
};

export interface ReplayOptions {
  /** Defaults to the store's `ingest` — the only mutation boundary. */
  ingest?: (event: LeadEvent) => void;
  /** Defaults to `setTimeout`; tests inject a manual clock. */
  schedule?: Scheduler;
  /** Playback multiplier. 1 replays at recorded speed. */
  speed?: number;
}

/**
 * A source that emits a recorded session through `ingest`, preserving order and
 * relative timing.
 *
 * Deliberately a single-timer chain rather than one timer per event: `stop()`
 * then has exactly one thing to cancel, and the `running` guard makes emission
 * after stop impossible even if a callback is already in flight.
 */
export function createReplaySource(
  session: ReplaySession,
  options: ReplayOptions = {},
): LeadSource {
  // Validate even an in-process session: a fixture edited by hand is untrusted
  // data too, and failing here beats replaying something subtly wrong.
  const { events, name } = parseSession(session);
  const ingest = options.ingest ?? ((event: LeadEvent) => useApsis.getState().ingest(event));
  const schedule = options.schedule ?? timeoutScheduler;
  const speed = options.speed && options.speed > 0 ? options.speed : 1;

  let cancel: (() => void) | null = null;
  let index = 0;
  let running = false;

  const step = () => {
    if (!running) return;
    const current = events[index];
    if (!current) {
      running = false;
      cancel = null;
      return;
    }
    ingest(current.event);
    index += 1;

    const next = events[index];
    if (!next) {
      running = false;
      cancel = null;
      return;
    }
    cancel = schedule(step, Math.max(0, (next.offsetMs - current.offsetMs) / speed));
  };

  return {
    name: `replay:${name}`,
    start() {
      if (running) return;
      const first = events[0];
      if (!first) return;
      running = true;
      index = 0;
      cancel = schedule(step, Math.max(0, first.offsetMs / speed));
    },
    stop() {
      running = false;
      cancel?.();
      cancel = null;
    },
  };
}

/* ------------------------------------------------------------ manual clock --- */

export interface ManualClock {
  schedule: Scheduler;
  /** Run everything due within the next `ms`, in time order. */
  advance(ms: number): void;
  now(): number;
  pending(): number;
}

/**
 * A deterministic scheduler for tests.
 *
 * Worth the twenty lines: replay is defined by *timing*, and testing timing
 * against real `setTimeout` means either sleeping (slow, flaky under the load
 * this machine sees) or not testing it at all.
 */
export function createManualClock(): ManualClock {
  interface Task { at: number; fn: () => void; cancelled: boolean }
  let current = 0;
  let queue: Task[] = [];

  return {
    schedule: (fn, delayMs) => {
      const task: Task = { at: current + Math.max(0, delayMs), fn, cancelled: false };
      queue.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = queue
          .filter((t) => !t.cancelled && t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        queue = queue.filter((t) => t !== due);
        current = due.at;
        due.fn();
      }
      current = target;
    },
    now: () => current,
    pending: () => queue.filter((t) => !t.cancelled).length,
  };
}
