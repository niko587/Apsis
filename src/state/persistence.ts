/**
 * Persistence v1 — durable event history and rehydration.
 *
 * THE MODEL
 * The persisted file is NOT an alternate authoritative store. It is a durable
 * copy of the canonical event log, and restoring means replaying that log
 * through the same `ingest` a live source uses:
 *
 *   saved log → validate → hydrate → ingest → scoring → store → gravity → UI
 *
 * No second mutation mechanism exists. Nothing here writes a store field.
 *
 * WHY THIS WORKS AT ALL — the property it depends on
 * `seedLeads` derives every lead's score, stage, theta and inclination from a
 * pure `rng(seed)` stream, so a fresh book is byte-reproducible across reloads.
 * Only `createdAt`/`lastEventAt` shift with wall clock, and `applyEvent` depends
 * on nothing but the prior score and the event kind. Replaying a saved log onto
 * a freshly seeded book therefore reproduces scores and stages exactly. If the
 * seed or book size ever differed, the same log would land on *different leads*
 * — which is why the book identity is recorded and checked on load.
 *
 * WHY IndexedDB
 * The simulator produces ~9 events/sec, so an hour of use is ~32,000 events —
 * several megabytes. localStorage caps around 5MB and is synchronous on the main
 * thread, which this project has spent seven rounds learning to keep clear.
 * IndexedDB is asynchronous and has room, so writes cannot jank a frame and a
 * long session is not silently lost at a size ceiling.
 */

import type { LeadEvent } from '../domain/types';
import { parseSession, REPLAY_FORMAT_VERSION, type RecordedEvent } from './replay';
import { useApsis, BOOK_SEED, bookLeadCount } from './store';

export const PERSIST_FORMAT_VERSION = 1;

/**
 * Hard ceiling on a stored log.
 *
 * At ~9 events/sec this is roughly 90 minutes of continuous use. On reaching it
 * the log is SEALED rather than trimmed: a sealed log is a correct *prefix* of
 * the session, so restoring it yields a state the session genuinely passed
 * through. Dropping the oldest events instead would leave a log that replays
 * into a plausible state the session never actually had, which is precisely the
 * failure this module refuses to produce.
 */
export const MAX_PERSISTED_EVENTS = 50_000;

/** Which book a log belongs to. A log is meaningless against a different one. */
export interface BookIdentity {
  readonly seed: number;
  readonly leadCount: number;
}

export interface PersistedSession {
  readonly version: number;
  readonly savedAt: number;
  readonly book: BookIdentity;
  /** True once the event cap was reached and recording stopped. */
  readonly sealed: boolean;
  readonly events: readonly RecordedEvent[];
}

export class PersistenceFormatError extends Error {
  constructor(message: string) {
    super(`persistence: ${message}`);
    this.name = 'PersistenceFormatError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate untrusted stored data.
 *
 * Event validation is delegated to `parseSession` so there is exactly one
 * definition of a well-formed event log in the codebase. Throws rather than
 * salvaging: a partially-applied history produces a believable session that
 * never happened, which is worse than starting clean and saying so.
 */
export function parsePersisted(raw: unknown): PersistedSession {
  if (!isRecord(raw)) throw new PersistenceFormatError('stored value must be an object');
  if (raw.version !== PERSIST_FORMAT_VERSION) {
    throw new PersistenceFormatError(
      `unsupported version ${String(raw.version)} (expected ${PERSIST_FORMAT_VERSION})`,
    );
  }
  if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)) {
    throw new PersistenceFormatError('savedAt must be a finite number');
  }
  if (!isRecord(raw.book)) throw new PersistenceFormatError('book identity missing');
  const { seed, leadCount } = raw.book;
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new PersistenceFormatError('book.seed must be a finite number');
  }
  if (typeof leadCount !== 'number' || !Number.isInteger(leadCount) || leadCount <= 0) {
    throw new PersistenceFormatError('book.leadCount must be a positive integer');
  }
  if (typeof raw.sealed !== 'boolean') throw new PersistenceFormatError('sealed must be a boolean');

  // Reuse the replay validator for the events themselves.
  const { events } = parseSession({
    version: REPLAY_FORMAT_VERSION,
    name: 'persisted',
    recordedAt: raw.savedAt,
    events: raw.events,
  });

  return {
    version: PERSIST_FORMAT_VERSION,
    savedAt: raw.savedAt,
    book: { seed, leadCount },
    sealed: raw.sealed,
    events,
  };
}

/* ---------------------------------------------------------------- storage --- */

/** Storage is deliberately dumb: it moves opaque values, it does not validate. */
export interface SessionStore {
  readonly name: string;
  available(): boolean;
  load(): Promise<unknown | null>;
  save(value: unknown): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'apsis';
const DB_VERSION = 1;
const STORE_NAME = 'session';
const RECORD_KEY = 'current';

export function createIndexedDbStore(): SessionStore {
  const openDb = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    });

  const run = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> =>
    openDb().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, mode);
          const request = fn(tx.objectStore(STORE_NAME));
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
          tx.oncomplete = () => db.close();
        }),
    );

  return {
    name: 'indexeddb',
    available: () => typeof indexedDB !== 'undefined',
    load: () => run<unknown>('readonly', (s) => s.get(RECORD_KEY)).then((v) => v ?? null),
    save: (value) => run<unknown>('readwrite', (s) => s.put(value, RECORD_KEY)).then(() => undefined),
    clear: () => run<unknown>('readwrite', (s) => s.delete(RECORD_KEY)).then(() => undefined),
  };
}

/** In-memory store. Used by tests; also the graceful fallback if IDB is absent. */
export function createMemoryStore(initial: unknown | null = null): SessionStore {
  let value: unknown | null = initial;
  return {
    name: 'memory',
    available: () => true,
    load: async () => value,
    save: async (v) => {
      value = v;
    },
    clear: async () => {
      value = null;
    },
  };
}

/* -------------------------------------------------------------- hydration --- */

/**
 * Apply a saved log to the live store, in order, through `ingest`.
 *
 * Timing is deliberately discarded. `offsetMs` describes playback, not state —
 * restoring a session is not a performance of it, and a user reloading the page
 * should not wait ninety minutes to get their book back. Order is what matters,
 * and order is preserved exactly.
 */
export function hydrate(
  session: PersistedSession,
  ingest: (event: LeadEvent) => void = (e) => useApsis.getState().ingest(e),
): number {
  for (const { event } of session.events) ingest(event);
  return session.events.length;
}

/** Why a load did not restore anything. Reported, never guessed at. */
export type RestoreOutcome =
  | { status: 'restored'; events: number; sealed: boolean }
  | { status: 'empty' }
  | { status: 'book-mismatch'; saved: BookIdentity; current: BookIdentity }
  | { status: 'corrupt'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface PersistenceStatus {
  store: string;
  /** False when storage is missing or every operation is failing. */
  active: boolean;
  restored: boolean;
  /** Events in the canonical in-memory log — what a write WOULD save. */
  events: number;
  /**
   * Events actually on disk, as of the last successful write.
   *
   * Distinct from `events` on purpose. Writes are throttled (`writeDelayMs`),
   * so the tail of the log is routinely in memory and not yet durable, and a
   * reload in that window loses it — `pagehide` starts a flush but cannot await
   * one. Reporting only `events` under the label "persistence" overstates what
   * would survive, which is the same overstatement D23 forbids for a
   * half-restored history. Anything wanting to know that the session is safe
   * must wait for this to reach `events`, not assume it.
   */
  persisted: number;
  version: number;
  sealed: boolean;
  lastError: string | null;
  outcome: RestoreOutcome['status'] | null;
}

export interface ControllerOptions {
  store?: SessionStore;
  book?: BookIdentity;
  now?: () => number;
  /** Debounce window for writes. Batched so a 9/s feed is not a 9/s write. */
  writeDelayMs?: number;
  schedule?: (fn: () => void, delayMs: number) => () => void;
  ingest?: (event: LeadEvent) => void;
}

export interface PersistenceController {
  restore(): Promise<RestoreOutcome>;
  /** Begin capturing live events. Safe to call once restore has settled. */
  startRecording(): void;
  stopRecording(): void;
  /** Force any pending write immediately (used on pagehide). */
  flush(): Promise<void>;
  clear(): Promise<void>;
  status(): PersistenceStatus;
}

/**
 * Owns the load → hydrate → record → save lifecycle.
 *
 * Recording observes the store's feed rather than wrapping `ingest`, exactly as
 * the Arc A recorder does: it captures events from every route (inbound, and
 * agent tasks resolving through `completeTask`) without adding anything that can
 * mutate state.
 */
export function createPersistenceController(options: ControllerOptions = {}): PersistenceController {
  const store = options.store ?? createIndexedDbStore();
  const book = options.book ?? { seed: BOOK_SEED, leadCount: bookLeadCount() };
  const now = options.now ?? Date.now;
  const writeDelayMs = options.writeDelayMs ?? 1500;
  const schedule =
    options.schedule ??
    ((fn: () => void, delayMs: number) => {
      const id = setTimeout(fn, delayMs);
      return () => clearTimeout(id);
    });
  const ingest = options.ingest ?? ((e: LeadEvent) => useApsis.getState().ingest(e));

  let events: RecordedEvent[] = [];
  /** Length of the log as of the last successful write. See `PersistenceStatus`. */
  let persistedCount = 0;
  let sealed = false;
  let startedAt: number | null = null;
  let lastSeenId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let cancelWrite: (() => void) | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastError: string | null = null;
  let active = store.available();
  let restored = false;
  let outcome: RestoreOutcome['status'] | null = null;

  const snapshot = (): PersistedSession => ({
    version: PERSIST_FORMAT_VERSION,
    savedAt: now(),
    book,
    sealed,
    events: [...events],
  });

  /**
   * Writes are chained, never concurrent: two in-flight `put`s could land in
   * either order and leave a shorter log on top of a longer one.
   */
  const write = (): Promise<void> => {
    writing = writing
      .then(async () => {
        // Count what THIS payload carried, not what the log holds once the
        // await resolves — more events can land while the write is in flight,
        // and claiming them as durable would be the overstatement `persisted`
        // exists to prevent.
        const payload = snapshot();
        await store.save(JSON.parse(JSON.stringify(payload)));
        persistedCount = payload.events.length;
        lastError = null;
      })
      .catch((error: unknown) => {
        // A failed write must not take the app down; the session simply stops
        // being durable, and diagnostics say so.
        lastError = error instanceof Error ? error.message : String(error);
        active = false;
      });
    return writing;
  };

  /**
   * Trailing THROTTLE, not a debounce.
   *
   * A debounce that restarts its timer on every event never fires while events
   * keep arriving — and the simulator emits ~9/sec, so the timer was cancelled
   * every ~110ms and the session was never written at all. Nothing errored;
   * IndexedDB was simply always empty. Here the first event after a quiet
   * moment schedules a write and subsequent events ride along with it, so a
   * write lands at least every `writeDelayMs` for as long as the feed runs.
   */
  const scheduleWrite = () => {
    if (cancelWrite) return;
    cancelWrite = schedule(() => {
      cancelWrite = null;
      void write();
    }, writeDelayMs);
  };

  return {
    async restore() {
      if (!store.available()) {
        active = false;
        outcome = 'unavailable';
        lastError = `${store.name} unavailable`;
        return { status: 'unavailable', reason: lastError };
      }
      let raw: unknown | null;
      try {
        raw = await store.load();
      } catch (error) {
        active = false;
        lastError = error instanceof Error ? error.message : String(error);
        outcome = 'unavailable';
        return { status: 'unavailable', reason: lastError };
      }
      if (raw === null || raw === undefined) {
        outcome = 'empty';
        return { status: 'empty' };
      }

      let parsed: PersistedSession;
      try {
        parsed = parsePersisted(raw);
      } catch (error) {
        // Corrupt history is discarded rather than partially applied, and the
        // slot is cleared so the next boot starts clean instead of failing again.
        lastError = error instanceof Error ? error.message : String(error);
        outcome = 'corrupt';
        await store.clear().catch(() => undefined);
        return { status: 'corrupt', reason: lastError };
      }

      if (parsed.book.seed !== book.seed || parsed.book.leadCount !== book.leadCount) {
        // Same event ids would land on different leads. Refuse, keep the saved
        // log (the user may return to the original book size), and start fresh.
        outcome = 'book-mismatch';
        return { status: 'book-mismatch', saved: parsed.book, current: book };
      }

      hydrate(parsed, ingest);
      events = [...parsed.events];
      // Everything just restored came off the disk, so it is durable by
      // definition — the log and the store agree at exactly this moment.
      persistedCount = parsed.events.length;
      sealed = parsed.sealed;
      startedAt = parsed.savedAt - (parsed.events.at(-1)?.offsetMs ?? 0);
      restored = true;
      outcome = 'restored';
      return { status: 'restored', events: parsed.events.length, sealed };
    },

    startRecording() {
      if (unsubscribe) return;
      if (startedAt === null) startedAt = now();
      lastSeenId = useApsis.getState().feed[0]?.id ?? null;
      unsubscribe = useApsis.subscribe((state) => {
        if (sealed) return;
        const head = state.feed[0];
        if (!head || head.id === lastSeenId) return;
        const fresh: LeadEvent[] = [];
        for (const event of state.feed) {
          if (event.id === lastSeenId) break;
          fresh.push(event);
        }
        lastSeenId = head.id;
        const offsetMs = Math.max(0, now() - (startedAt ?? 0));
        for (let i = fresh.length - 1; i >= 0; i--) {
          if (events.length >= MAX_PERSISTED_EVENTS) {
            sealed = true;
            break;
          }
          events.push({ offsetMs, event: fresh[i] });
        }
        scheduleWrite();
      });
    },

    stopRecording() {
      unsubscribe?.();
      unsubscribe = null;
    },

    async flush() {
      cancelWrite?.();
      cancelWrite = null;
      await write();
    },

    async clear() {
      cancelWrite?.();
      cancelWrite = null;
      events = [];
      persistedCount = 0;
      sealed = false;
      restored = false;
      startedAt = null;
      await writing.catch(() => undefined);
      await store.clear().catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
      });
    },

    status() {
      return {
        store: store.name,
        active,
        restored,
        events: events.length,
        persisted: persistedCount,
        version: PERSIST_FORMAT_VERSION,
        sealed,
        lastError,
        outcome,
      };
    },
  };
}
