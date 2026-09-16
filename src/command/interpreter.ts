/**
 * The provider seam, and the boundary Apsis must never cross.
 *
 * APSIS IS A BROWSER-ONLY SPA WITH NO SERVER. Everything in this file follows
 * from that one fact:
 *
 *   **Any API key reachable by this application is public.** `VITE_*` variables
 *   are inlined into the bundle at build time and `import.meta.env` values are
 *   readable in devtools. Shipping a vendor credential to the browser publishes
 *   it, and it must be treated as compromised the moment it is built.
 *
 * So Apsis holds no credential and speaks to no vendor. It POSTs to an endpoint
 * the HOST declares and operates; whoever runs Apsis owns that endpoint, keeps
 * the key server-side, and carries the rate limiting and abuse problem. That
 * boundary is also what keeps the vendor swappable — nothing here knows or
 * cares which model answers.
 *
 * What leaves the browser is the user's command text and a static description of
 * the `LeadQuery` vocabulary. Never a lead, a name, a phone number, an email, a
 * score, or anything from the event log (§L). The model is a language
 * interpreter, not a lead database: parsing "hot leads in Florida" requires
 * knowing that `hot` and `FL` exist, not who they are.
 *
 * Activation copies the §37 idiom `detectCapabilities` already establishes — the
 * environment declares what is reachable and the default is "nothing is, and we
 * say so" rather than a guess. No declared endpoint means no interpreter exists,
 * and the grammar runs exactly as it does today.
 *
 * `fetch` only. No SDK, nothing to tree-shake, nothing to lazily load.
 */

import { COMMAND_SCHEMA } from './parseInterpretation';

/**
 * The seam. One interface, one implementation.
 *
 * `interpret` returns `unknown` on purpose: whatever comes back is a suggestion
 * from a language model and is not trusted to be anything at all until
 * `parseInterpretation` has finished with it.
 */
export interface CommandInterpreter {
  readonly name: string;
  interpret(text: string, signal: AbortSignal): Promise<unknown>;
}

export interface InterpreterConfig {
  /** A URL the host provides and controls. Never a vendor API. */
  endpoint: string;
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 4000;

/** Thrown when the endpoint did not answer in time. Distinguishable for the note. */
export class InterpreterTimeoutError extends Error {
  constructor() {
    super('interpreter timed out');
    this.name = 'InterpreterTimeoutError';
  }
}

/** Thrown for a transport-level refusal: DNS, CORS, offline, non-2xx. */
export class InterpreterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterUnavailableError';
  }
}

interface HostScope {
  __APSIS_COMMAND_INTERPRETER__?: unknown;
  location?: { search?: string };
}

/**
 * Read the host's declaration, or decide that no interpreter exists.
 *
 * Deliberately shaped like `detectCapabilities`: absent, malformed, or a
 * non-string endpoint all mean the same thing, and that thing is `null`. There
 * is no inference, no default endpoint and no "try it and see".
 *
 * `?interpreter=off` forces the same answer, so the grammar path can be
 * reproduced on a host that has an interpreter configured.
 */
export function readInterpreterConfig(
  globalScope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis,
): InterpreterConfig | null {
  const scope = globalScope as HostScope | undefined;

  const search = scope?.location?.search;
  if (typeof search === 'string' && new URLSearchParams(search).get('interpreter') === 'off') {
    return null;
  }

  const declared = scope?.__APSIS_COMMAND_INTERPRETER__;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return null;

  const d = declared as { endpoint?: unknown; timeoutMs?: unknown };
  if (typeof d.endpoint !== 'string' || d.endpoint.trim().length === 0) return null;

  const timeoutMs =
    typeof d.timeoutMs === 'number' && Number.isFinite(d.timeoutMs) && d.timeoutMs > 0
      ? d.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  return { endpoint: d.endpoint, timeoutMs };
}

/** Exactly what goes over the wire. Enumerated as a type so it cannot grow by accident. */
export interface InterpreterRequest {
  text: string;
  schema: typeof COMMAND_SCHEMA;
}

export const buildRequestBody = (text: string): InterpreterRequest => ({
  text,
  schema: COMMAND_SCHEMA,
});

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The one implementation: POST `{ text, schema }` to the host's endpoint.
 *
 * The timeout is composed here rather than by the caller, so the caller's signal
 * keeps meaning exactly one thing — the user superseded or cancelled this
 * command — and a timeout is never mistaken for a cancellation. `AbortSignal.any`
 * is avoided in favour of a plain controller: this has to run in whatever
 * browser the owner has, not whatever browser is newest.
 */
export function createHostInterpreter(
  config: InterpreterConfig,
  fetchImpl?: FetchLike,
): CommandInterpreter {
  return {
    name: 'host',
    async interpret(text: string, signal: AbortSignal): Promise<unknown> {
      const doFetch =
        fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
      if (!doFetch) throw new InterpreterUnavailableError('fetch is unavailable');

      const controller = new AbortController();
      let timedOut = false;

      const onOuterAbort = () => controller.abort(signal.reason);
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onOuterAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);

      try {
        const response = await doFetch(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildRequestBody(text)),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new InterpreterUnavailableError(`endpoint returned ${response.status}`);
        }
        // Malformed JSON throws here and the router falls back — a body that is
        // not JSON is not an interpretation.
        return (await response.json()) as unknown;
      } catch (error) {
        if (timedOut) throw new InterpreterTimeoutError();
        // A genuine cancellation belongs to the caller and must stay
        // distinguishable from a failure, which is why it is rethrown as-is.
        if (signal.aborted) throw error;
        if (error instanceof InterpreterUnavailableError) throw error;
        throw new InterpreterUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onOuterAbort);
      }
    },
  };
}
