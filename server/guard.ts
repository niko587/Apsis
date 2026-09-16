/**
 * Everything that must be true before a request is allowed to cost money.
 *
 * Pure functions over a `Request`. No provider, no network, no platform: the
 * guards are the cheapest part of the endpoint and the part most worth testing
 * on its own, because every one of them exists to stop something.
 *
 * The ordering is deliberate — method, origin and content-type are free; the
 * rate limit is nearly free and comes next so that a flood is rejected before
 * a single byte of body is read; then the size cap, then parsing. Reading an
 * 8 MB body and measuring it afterwards is not a size limit, it is a slower way
 * to accept one.
 */

const MAX_BODY_BYTES = 8 * 1024;
const MAX_TEXT_CHARS = 512;
/** Only these may appear at the top level. Anything else is a client we do not know. */
const ALLOWED_KEYS = new Set(['text', 'schema']);

export interface RateLimitConfig {
  perMinute: number;
  perHour: number;
}

export interface GuardConfig {
  /** Origin that may call this endpoint. Undefined disables the check (local dev, curl). */
  allowedOrigin?: string;
  maxBodyBytes: number;
  maxTextChars: number;
  rateLimit: RateLimitConfig;
}

export const DEFAULT_GUARD: GuardConfig = {
  allowedOrigin: undefined,
  maxBodyBytes: MAX_BODY_BYTES,
  maxTextChars: MAX_TEXT_CHARS,
  rateLimit: { perMinute: 20, perHour: 200 },
};

export interface GuardFailure {
  status: number;
  /** A safe code. Never a vendor message, never a stack, never anything user-supplied. */
  code: string;
  headers?: Record<string, string>;
}

export type GuardResult = { ok: true; text: string } | { ok: false; failure: GuardFailure };

/* ------------------------------------------------------------ rate limit --- */

/**
 * A per-IP token bucket, in memory.
 *
 * HONEST SCOPE, because overstating this would be worse than not having it:
 * serverless instances do not share memory, so with N warm instances the real
 * ceiling is roughly N times the configured one. This is COST CONTROL and
 * friction. It is not authentication, it is not a global guarantee, and it does
 * not make the endpoint safe to expose without auth. Platform-level rate
 * limiting and a vendor spend cap are the layers that actually enforce; this is
 * the one that stops a runaway loop in a browser tab.
 */
export interface RateLimiter {
  check(key: string, now: number): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const minute = new Map<string, number[]>();
  const hour = new Map<string, number[]>();

  const sweep = (store: Map<string, number[]>, key: string, now: number, windowMs: number) => {
    const hits = (store.get(key) ?? []).filter((t) => now - t < windowMs);
    store.set(key, hits);
    return hits;
  };

  return {
    check(key, now) {
      const perMinute = sweep(minute, key, now, 60_000);
      const perHour = sweep(hour, key, now, 3_600_000);

      if (perMinute.length >= config.perMinute) {
        const oldest = perMinute[0];
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000)) };
      }
      if (perHour.length >= config.perHour) {
        const oldest = perHour[0];
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((3_600_000 - (now - oldest)) / 1000)) };
      }

      perMinute.push(now);
      perHour.push(now);
      // Unbounded key growth is the obvious leak here; a swept-empty bucket is
      // dropped so an instance that sees many IPs once does not retain them.
      if (perHour.length === 0) hour.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

/**
 * Best-effort client identity.
 *
 * `x-forwarded-for` is client-writable in general; behind a platform proxy the
 * leftmost entry is the one the platform observed, which is what we want and
 * also what an attacker could forge if the endpoint were reachable without the
 * proxy. Treated accordingly: good enough to bucket honest traffic, never
 * treated as identity.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/* ---------------------------------------------------------------- body ----- */

/**
 * Read at most `maxBytes`, then stop.
 *
 * Streams and counts rather than buffering and checking, so an oversized body
 * is abandoned mid-flight instead of being fully received and then rejected.
 */
async function readBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false };
  }

  const body = request.body;
  if (!body) return { ok: true, text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false };
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

/* --------------------------------------------------------------- guard ----- */

const fail = (status: number, code: string, headers?: Record<string, string>): GuardResult => ({
  ok: false,
  failure: { status, code, headers },
});

export async function guardRequest(
  request: Request,
  config: GuardConfig = DEFAULT_GUARD,
  limiter?: RateLimiter,
  now: number = Date.now(),
): Promise<GuardResult> {
  if (request.method !== 'POST') {
    return fail(405, 'method_not_allowed', { allow: 'POST' });
  }

  // Same-origin only. An absent Origin is a non-browser caller (curl, a health
  // check) and is allowed; a PRESENT and wrong one is a cross-site attempt.
  if (config.allowedOrigin) {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== config.allowedOrigin) return fail(403, 'cross_origin');
  }
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return fail(403, 'cross_origin');

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return fail(415, 'unsupported_media_type');
  }

  if (limiter) {
    const verdict = limiter.check(clientKey(request), now);
    if (!verdict.allowed) {
      return fail(429, 'rate_limited', { 'retry-after': String(verdict.retryAfterSeconds) });
    }
  }

  const body = await readBodyCapped(request, config.maxBodyBytes);
  if (!body.ok) return fail(413, 'payload_too_large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return fail(400, 'malformed_json');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(400, 'malformed_request');
  }

  // Unknown keys are rejected rather than ignored: a client that has started
  // sending more than we agreed to send is worth noticing, not absorbing.
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_KEYS.has(key)) return fail(400, 'unknown_field');
  }

  const { text } = parsed as { text?: unknown };
  if (typeof text !== 'string') return fail(400, 'text_required');

  const trimmed = text.trim();
  if (trimmed.length === 0) return fail(400, 'text_required');
  if (trimmed.length > config.maxTextChars) return fail(413, 'text_too_long');

  // `schema` is intentionally not read. See prompt.ts — the server builds its
  // request from its own pinned vocabulary, never from the client's.
  return { ok: true, text: trimmed };
}
