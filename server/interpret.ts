/**
 * `POST /api/interpret` — Apsis's first server-side boundary.
 *
 * A plain `Request -> Promise<Response>`, which is what Vercel, Netlify,
 * Cloudflare and Deno all accept. Nothing in this file knows which one it is
 * running on; `api/interpret.ts` is the only file that does.
 *
 * THIS ENDPOINT IS NOT A TRUSTED COMPONENT. Forced tool use narrows what the
 * model can say, but a schema-shaped lie — a real field, a plausible value, a
 * span the user never typed — is still expressible. The browser validator
 * (`src/command/parseInterpretation.ts`) governs what actually reaches
 * `LeadQuery`, and if this endpoint disappears entirely the product still works
 * because the grammar is always a correct answer. Both halves of that are
 * deliberate, and the server is written to match: it trims for size and shape,
 * and it does not try to be the last line of defence.
 *
 * Two untrusted inputs, in both directions: the browser's request and the
 * model's response. Neither is believed.
 */

import {
  DEFAULT_GUARD,
  createRateLimiter,
  guardRequest,
  type GuardConfig,
  type RateLimiter,
} from './guard';
import { LIMITS } from './prompt';
import { ProviderError, providerFromEnv, type ModelProvider } from './provider';

/** Inner fails first, so the layer outside never has to guess (contract §K). */
export const TIMEOUTS = { provider: 3000, total: 3500 } as const;

export interface HandlerOptions {
  /** `null` means "no provider configured" — a 502, never an uncredentialed call. */
  provider?: ModelProvider | null;
  guard?: Partial<GuardConfig>;
  limiter?: RateLimiter;
  timeouts?: { provider: number; total: number };
  now?: () => number;
  /** Structured operational record. Never text, never prompts, never envelopes. */
  log?: (entry: LogEntry) => void;
}

/**
 * What an operational log may contain.
 *
 * Note what is absent and why: the command text is user input that routinely
 * contains a person's name ("find the Moreau lead"), so a command log is a PII
 * log wearing a different hat. Prompts, model output and the envelope are
 * absent for the same reason — the envelope carries spans, which are verbatim
 * fragments of the command.
 */
export interface LogEntry {
  at: number;
  requestId: string;
  outcome: string;
  status: number;
  latencyMs: number;
  providerLatencyMs: number | null;
  model: string | null;
  errorClass: string | null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });

/** Error bodies carry a code and nothing else. No vendor text, no stack, no echo. */
const errorResponse = (status: number, code: string, headers?: Record<string, string>) =>
  json(status, { error: code }, headers);

/**
 * Trim the model's envelope to something bounded.
 *
 * SHAPE ONLY. Value semantics — is `cold` a real stage, is this span actually
 * in the command — belong to the browser validator, and a second implementation
 * of those rules here would eventually disagree with the one that governs. What
 * this does is stop a model from handing the browser ten thousand filters or a
 * megabyte span to loop over.
 */
export function trimEnvelope(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('provider_unusable');
  }
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.filters)) throw new ProviderError('provider_unusable');

  const clip = (value: unknown, max: number): unknown =>
    typeof value === 'string' && value.length > max ? value.slice(0, max) : value;

  const filters = input.filters
    .filter((entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object' && !Array.isArray(entry),
    )
    .slice(0, LIMITS.MAX_FILTERS)
    .map((entry) => ({
      field: entry.field,
      value: Array.isArray(entry.value)
        ? entry.value.slice(0, LIMITS.MAX_FILTERS).map((v) => clip(v, LIMITS.VALUE_MAX))
        : clip(entry.value, LIMITS.VALUE_MAX),
      span: clip(entry.span, LIMITS.SPAN_MAX),
    }));

  const out: Record<string, unknown> = { filters };
  if (typeof input.action === 'string') out.action = input.action;
  if (typeof input.actionSpan === 'string') out.actionSpan = clip(input.actionSpan, LIMITS.SPAN_MAX);
  if (Array.isArray(input.unmapped)) {
    out.unmapped = input.unmapped
      .filter((v): v is string => typeof v === 'string')
      .slice(0, LIMITS.MAX_UNMAPPED)
      .map((v) => v.slice(0, LIMITS.SPAN_MAX));
  }
  return out;
}

export function createInterpretHandler(options: HandlerOptions = {}) {
  const guardConfig: GuardConfig = { ...DEFAULT_GUARD, ...options.guard };
  const limiter = options.limiter ?? createRateLimiter(guardConfig.rateLimit);
  const timeouts = options.timeouts ?? TIMEOUTS;
  const clock = options.now ?? Date.now;
  const provider =
    options.provider !== undefined ? options.provider : providerFromEnv();

  return async function handleInterpret(request: Request): Promise<Response> {
    const startedAt = clock();
    const requestId =
      request.headers.get('x-request-id') ?? Math.random().toString(36).slice(2, 10);
    let providerLatencyMs: number | null = null;

    const record = (status: number, outcome: string, errorClass: string | null = null) => {
      options.log?.({
        at: startedAt,
        requestId,
        outcome,
        status,
        latencyMs: clock() - startedAt,
        providerLatencyMs,
        model: provider?.name ?? null,
        errorClass,
      });
    };

    try {
      const guarded = await guardRequest(request, guardConfig, limiter, startedAt);
      if (!guarded.ok) {
        const { status, code, headers } = guarded.failure;
        record(status, code);
        return errorResponse(status, code, headers);
      }

      if (!provider) {
        record(502, 'provider_unconfigured');
        return errorResponse(502, 'provider_unconfigured');
      }

      // Three reasons to stop waiting, one controller: our provider deadline,
      // the total deadline, and the browser hanging up. The last one matters
      // for cost — an abandoned command should stop consuming model resources
      // rather than run to completion for nobody.
      const abort = new AbortController();
      let timedOut = false;
      const providerTimer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeouts.provider);
      const onClientGone = () => abort.abort();
      request.signal?.addEventListener('abort', onClientGone, { once: true });

      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      const totalDeadline = new Promise<'timeout'>((resolve) => {
        totalTimer = setTimeout(() => {
          timedOut = true;
          abort.abort();
          resolve('timeout');
        }, timeouts.total);
      });

      try {
        const providerStarted = clock();
        const outcome = await Promise.race([
          provider.interpret(guarded.text, abort.signal).then((raw) => ({ raw })),
          totalDeadline,
        ]);
        providerLatencyMs = clock() - providerStarted;

        if (outcome === 'timeout') {
          record(504, 'server_timeout');
          return errorResponse(504, 'server_timeout');
        }

        const envelope = trimEnvelope(outcome.raw);
        record(200, 'interpreted');
        return json(200, envelope);
      } catch (error) {
        providerLatencyMs ??= clock() - startedAt;

        if (timedOut) {
          record(504, 'provider_timeout');
          return errorResponse(504, 'provider_timeout');
        }
        if (request.signal?.aborted) {
          // The browser hung up. Nothing is waiting for this response; the
          // status exists only so the function has something to return.
          record(499, 'client_closed');
          return errorResponse(499, 'client_closed');
        }
        if (error instanceof ProviderError) {
          record(502, error.code, 'ProviderError');
          return errorResponse(502, error.code);
        }
        record(502, 'provider_failed', error instanceof Error ? error.name : 'unknown');
        return errorResponse(502, 'provider_failed');
      } finally {
        clearTimeout(providerTimer);
        clearTimeout(totalTimer);
        request.signal?.removeEventListener('abort', onClientGone);
      }
    } catch (error) {
      // Unreachable by design. A handler that can throw out of the top turns a
      // recoverable failure into a platform 500 with an unpredictable body, so
      // there is a floor under it.
      record(502, 'unhandled', error instanceof Error ? error.name : 'unknown');
      return errorResponse(502, 'provider_failed');
    }
  };
}

/** The production handler, built from the environment. */
export const handleInterpret = createInterpretHandler({
  guard: { allowedOrigin: process.env.APSIS_ALLOWED_ORIGIN },
});
