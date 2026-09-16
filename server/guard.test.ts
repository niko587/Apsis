/**
 * The guards, tested before a provider exists — §R.3.
 *
 * Each case is a thing someone could send. None of them should ever reach a
 * model, and the point of testing this layer alone is that "we never called the
 * provider" is a property of the guard, not of the handler that wraps it.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARD,
  clientKey,
  createRateLimiter,
  guardRequest,
  type GuardConfig,
} from './guard';

const URL_ = 'https://apsis.test/api/interpret';

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const failure = async (request: Request, config: GuardConfig = DEFAULT_GUARD) => {
  const result = await guardRequest(request, config);
  expect(result.ok, 'expected the guard to reject this').toBe(false);
  return result.ok ? null : result.failure;
};

describe('method and transport', () => {
  it('accepts a well-formed POST', async () => {
    const result = await guardRequest(post({ text: 'find cold leads' }));
    expect(result).toEqual({ ok: true, text: 'find cold leads' });
  });

  it('rejects anything but POST, and says what is allowed', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const f = await failure(new Request(URL_, { method }));
      expect(f?.status, method).toBe(405);
      expect(f?.headers?.allow).toBe('POST');
    }
  });

  it('rejects a content-type that is not JSON', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const f = await failure(post('{"text":"x"}', { 'content-type': type }));
      expect(f?.status, type).toBe(415);
    }
    // A charset suffix is still JSON.
    const ok = await guardRequest(post({ text: 'hi there' }, { 'content-type': 'application/json; charset=utf-8' }));
    expect(ok.ok).toBe(true);
  });
});

describe('origin', () => {
  const config: GuardConfig = { ...DEFAULT_GUARD, allowedOrigin: 'https://apsis.test' };

  it('rejects a cross-origin browser request', async () => {
    const f = await failure(post({ text: 'x' }, { origin: 'https://evil.test' }), config);
    expect(f?.status).toBe(403);
    expect(f?.code).toBe('cross_origin');
  });

  it('allows the configured origin', async () => {
    const result = await guardRequest(post({ text: 'find cold leads' }, { origin: 'https://apsis.test' }), config);
    expect(result.ok).toBe(true);
  });

  it('allows an origin-less caller — curl and health checks are not attacks', async () => {
    const result = await guardRequest(post({ text: 'find cold leads' }), config);
    expect(result.ok).toBe(true);
  });

  it('rejects cross-site by Sec-Fetch-Site even with no Origin configured', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const f = await failure(post({ text: 'x' }, { 'sec-fetch-site': site }));
      expect(f?.status, site).toBe(403);
    }
    for (const site of ['same-origin', 'none']) {
      const result = await guardRequest(post({ text: 'find cold leads' }, { 'sec-fetch-site': site }));
      expect(result.ok, site).toBe(true);
    }
  });
});

describe('size', () => {
  it('rejects a body over the cap', async () => {
    const f = await failure(post({ text: 'x', schema: { pad: 'y'.repeat(9000) } }));
    expect(f?.status).toBe(413);
    expect(f?.code).toBe('payload_too_large');
  });

  it('rejects an oversized body WITHOUT parsing it', async () => {
    // Not valid JSON at all. If the guard tried to parse before measuring, this
    // would come back 400 rather than 413 — which is how you tell a real size
    // cap from a size check that runs too late.
    const f = await failure(post('{'.repeat(9000)));
    expect(f?.status).toBe(413);
  });

  it('rejects a body whose declared content-length is over the cap, before reading', async () => {
    const request = new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      body: JSON.stringify({ text: 'small' }),
    });
    expect((await failure(request))?.status).toBe(413);
  });

  it('rejects text over 512 characters', async () => {
    const f = await failure(post({ text: 'a'.repeat(513) }));
    expect(f?.status).toBe(413);
    expect(f?.code).toBe('text_too_long');

    const ok = await guardRequest(post({ text: 'a'.repeat(512) }));
    expect(ok.ok).toBe(true);
  });
});

describe('shape', () => {
  it('rejects malformed JSON', async () => {
    expect((await failure(post('not json at all')))?.status).toBe(400);
    expect((await failure(post('{"text":')))?.code).toBe('malformed_json');
  });

  it('rejects a non-object envelope', async () => {
    for (const body of ['null', '42', '"text"', '[]', '[{"text":"x"}]']) {
      const f = await failure(post(body));
      expect(f?.status, body).toBe(400);
    }
  });

  it('rejects unknown top-level keys rather than ignoring them', async () => {
    const f = await failure(post({ text: 'x', leads: [{ name: 'Claire' }] }));
    expect(f?.status).toBe(400);
    expect(f?.code).toBe('unknown_field');
  });

  it('requires text to be a non-empty string', async () => {
    for (const text of [undefined, null, 42, {}, [], true, '', '   ', '\n\t ']) {
      const f = await failure(post({ text }));
      expect(f?.status, JSON.stringify(text) ?? 'undefined').toBe(400);
      expect(f?.code).toBe('text_required');
    }
  });

  it('returns the TRIMMED text, so the provider never sees padding', async () => {
    const result = await guardRequest(post({ text: '   find cold leads   ' }));
    expect(result).toEqual({ ok: true, text: 'find cold leads' });
  });

  it('accepts a schema field and does not care what is in it', async () => {
    // Ignored, not validated: the server never reads it. See prompt.ts.
    const result = await guardRequest(post({ text: 'find cold leads', schema: { anything: true } }));
    expect(result).toEqual({ ok: true, text: 'find cold leads' });
  });
});

describe('rate limiting', () => {
  const ip = (addr: string) => post({ text: 'find cold leads' }, { 'x-forwarded-for': addr });

  it('allows up to the limit, then answers 429 with Retry-After', async () => {
    const limiter = createRateLimiter({ perMinute: 3, perHour: 100 });
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const result = await guardRequest(ip('1.1.1.1'), DEFAULT_GUARD, limiter, now);
      expect(result.ok, `request ${i + 1}`).toBe(true);
    }
    const result = await guardRequest(ip('1.1.1.1'), DEFAULT_GUARD, limiter, now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.status).toBe(429);
      expect(Number(result.failure.headers?.['retry-after'])).toBeGreaterThan(0);
    }
  });

  it('buckets per IP — one caller cannot lock out another', async () => {
    const limiter = createRateLimiter({ perMinute: 1, perHour: 100 });
    const now = 1_000_000;
    expect((await guardRequest(ip('1.1.1.1'), DEFAULT_GUARD, limiter, now)).ok).toBe(true);
    expect((await guardRequest(ip('1.1.1.1'), DEFAULT_GUARD, limiter, now)).ok).toBe(false);
    expect((await guardRequest(ip('2.2.2.2'), DEFAULT_GUARD, limiter, now)).ok).toBe(true);
  });

  it('forgets a bucket once its window has passed', async () => {
    const limiter = createRateLimiter({ perMinute: 1, perHour: 100 });
    expect((await guardRequest(ip('1.1.1.1'), DEFAULT_GUARD, limiter, 0)).ok).toBe(true);
    expect((await guardRequest(ip('1.1.1.1'), DEFAULT_GUARD, limiter, 30_000)).ok).toBe(false);
    expect((await guardRequest(ip('1.1.1.1'), DEFAULT_GUARD, limiter, 61_000)).ok).toBe(true);
  });

  it('applies the hourly ceiling as well as the per-minute one', async () => {
    const limiter = createRateLimiter({ perMinute: 100, perHour: 2 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 61_000).allowed).toBe(true);
    expect(limiter.check('a', 122_000).allowed).toBe(false);
  });

  it('rate limits BEFORE reading the body, so a flood is cheap to refuse', async () => {
    const limiter = createRateLimiter({ perMinute: 1, perHour: 100 });
    await guardRequest(post({ text: 'first' }), DEFAULT_GUARD, limiter, 0);
    // Oversized AND over the limit: the 429 proves the limiter ran first.
    const f = await guardRequest(post('{'.repeat(9000)), DEFAULT_GUARD, limiter, 0);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.failure.status).toBe(429);
  });

  it('reads the client key from the platform headers', () => {
    expect(clientKey(post({}, { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
    expect(clientKey(post({}, { 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    expect(clientKey(post({}))).toBe('unknown');
  });
});
