/**
 * Source selection.
 *
 * One place that decides which concrete source is running, so `App` does not
 * grow a branch per transport and future sources (CRM webhook, dialer stream,
 * SSE from an agent runner) are added here rather than in the UI.
 *
 * `?source=replay` plays the built-in fixture; anything else — including no
 * parameter at all — is the simulator, exactly as it has always been.
 */

import { createSimulatedSource, type LeadSource } from './source';
import { createReplaySource } from './replay';
import { demoSession } from './fixtures/demoSession';

export type SourceKind = 'simulator' | 'replay';

export function requestedSourceKind(): SourceKind {
  if (typeof window === 'undefined') return 'simulator';
  // Only the exact string opts in; a typo falls back to shipping behaviour
  // rather than leaving the app with no event feed at all.
  return new URLSearchParams(window.location.search).get('source') === 'replay'
    ? 'replay'
    : 'simulator';
}

/**
 * Build the configured source.
 *
 * The replay fixture is anchored to `now` so its appointments land in the
 * future like the simulator's do; the session is constructed with those
 * timestamps rather than recorded events being rewritten.
 */
export function createConfiguredSource(): LeadSource {
  if (requestedSourceKind() === 'replay') {
    return createReplaySource(demoSession(Date.now()));
  }
  return createSimulatedSource({ eventsPerSecond: 9 });
}
