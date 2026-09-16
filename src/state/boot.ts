/**
 * Session boot: restore, then go live. In that order, exactly once.
 *
 * The failure this file exists to prevent is subtle and would be very hard to
 * see: if the simulator starts while the saved log is still being replayed, live
 * events interleave with restored history, the recorder captures the mixture,
 * and the next reload restores a session that never happened. Worse, React
 * StrictMode double-invokes effects in development, so a naive implementation
 * would hydrate twice and double-apply every event in the log.
 *
 * So boot is a module-level singleton promise. Whoever asks first performs it;
 * everyone else awaits the same result. It resolves only once the log has been
 * fully applied, and only then does the caller start a source.
 *
 * `?source=replay` is deliberately isolated: it neither reads nor writes the
 * persisted session. The demo fixture is a diagnostic, and it must not be able
 * to overwrite a real book.
 */

import {
  createPersistenceController,
  type PersistenceController,
  type PersistenceStatus,
  type RestoreOutcome,
} from './persistence';
import { requestedSourceKind } from './sources';

export interface BootResult {
  outcome: RestoreOutcome;
  /** Null in replay mode — nothing is recorded or restored there. */
  controller: PersistenceController | null;
}

let bootPromise: Promise<BootResult> | null = null;
/**
 * The live controller, not a snapshot of it.
 *
 * An earlier version cached `controller.status()` at boot, so the diagnostics
 * line reported "0 events" for the rest of the session no matter how much was
 * recorded — a status that cannot change is not a status. The browser reload
 * test caught it.
 */
let activeController: PersistenceController | null = null;

/**
 * Restore the persisted session, then begin recording. Idempotent.
 *
 * `overrides` exists for tests; production passes nothing.
 */
export function bootSession(overrides?: {
  controller?: PersistenceController;
  isolated?: boolean;
}): Promise<BootResult> {
  if (bootPromise) return bootPromise;

  const isolated = overrides?.isolated ?? requestedSourceKind() === 'replay';
  if (isolated) {
    bootPromise = Promise.resolve({ outcome: { status: 'empty' } as RestoreOutcome, controller: null });
    return bootPromise;
  }

  const controller = overrides?.controller ?? createPersistenceController();
  bootPromise = (async () => {
    const outcome = await controller.restore();
    // Recording starts AFTER hydration, so restored events are not re-recorded
    // and live events append to the log they continue from.
    controller.startRecording();
    activeController = controller;
    publishForDiagnostics();
    return { outcome, controller };
  })();
  return bootPromise;
}

/** Live persistence status, for diagnostics. Never load-bearing. */
export function persistenceStatus(): PersistenceStatus | null {
  return activeController?.status() ?? null;
}

export function refreshPersistenceStatus(controller: PersistenceController | null): void {
  if (controller) activeController = controller;
  publishForDiagnostics();
}

/**
 * Published for the diagnostics report only. Reading state must never require
 * importing the diag module into the state layer.
 */
function publishForDiagnostics(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __apsisPersistence?: () => unknown }).__apsisPersistence = () =>
    persistenceStatus();
}

/** Test-only: forget the singleton so a fresh boot can be exercised. */
export function resetBootForTests(): void {
  bootPromise = null;
  activeController = null;
}
