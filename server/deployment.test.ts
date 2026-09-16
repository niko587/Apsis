/**
 * Deployment hardening — three defects found in review, each pinned here.
 *
 * All three shared a shape: code that looked right, had no test, and would only
 * have failed in production. The tests below are the reason each cannot come
 * back quietly.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODEL, buildMessagesRequest } from './provider';
import { createRateLimiter } from './guard';
import { TOOL_NAME } from './prompt';

const ROOT = join(import.meta.dirname, '..');

/* ------------------------------------------------- 1. sampling parameters --- */

describe('the outbound Messages request carries no sampling parameters', () => {
  /**
   * WHY THIS MATTERS, IN ONE SENTENCE: Claude Sonnet 5 returns a 400 for
   * `temperature`, `top_p` or `top_k` set to non-default values, and Sonnet 5
   * is the documented escalation path — so the previous `temperature: 0` made
   * `APSIS_MODEL=claude-sonnet-5` a one-variable outage in which every command
   * became a 502 and every user was silently demoted to the grammar.
   *
   * Verified against platform.claude.com/docs/en/models/sonnet-5/overview:
   * "Setting `temperature`, `top_p`, or `top_k` to non-default values returns a
   * 400 error."
   */
  const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

  it.each(MODELS)('%s: the exact payload, key for key', (model) => {
    const request = buildMessagesRequest(model, 'show me hot leads in Florida');

    // The whole top-level shape, asserted exactly — an added key has to be
    // added here too, which is the point.
    expect(Object.keys(request).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'system',
      'tool_choice',
      'tools',
    ]);

    expect(request.model).toBe(model);
    expect(request.max_tokens).toBe(1024);
    expect(request.messages).toEqual([
      { role: 'user', content: '<command>\nshow me hot leads in Florida\n</command>' },
    ]);
    expect(request.tool_choice).toEqual({ type: 'tool', name: TOOL_NAME });
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].name).toBe(TOOL_NAME);
  });

  it.each(MODELS)('%s: sends no temperature, top_p or top_k at all', (model) => {
    const request = buildMessagesRequest(model, 'find cold leads') as unknown as Record<
      string,
      unknown
    >;
    for (const key of ['temperature', 'top_p', 'top_k', 'topP', 'topK']) {
      expect(key in request, `${key} must not be sent to ${model}`).toBe(false);
    }
    // Not merely undefined — absent from the serialised body.
    const body = JSON.stringify(request);
    expect(body).not.toContain('temperature');
    expect(body).not.toContain('top_p');
    expect(body).not.toContain('top_k');
  });

  it('both models get an identical payload apart from the model id', () => {
    // The fix is the ABSENCE of a capability table. If a per-model branch ever
    // appears, this fails and whoever added it has to justify it.
    const haiku = buildMessagesRequest('claude-haiku-4-5-20251001', 'find cold leads');
    const sonnet = buildMessagesRequest('claude-sonnet-5', 'find cold leads');
    expect({ ...haiku, model: 'X' }).toEqual({ ...sonnet, model: 'X' });
  });

  it('the default model is the documented one', () => {
    expect(DEFAULT_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('no source file mentions a sampling parameter', () => {
    for (const file of ['provider.ts', 'prompt.ts', 'interpret.ts']) {
      const source = readFileSync(join(ROOT, 'server', file), 'utf8');
      // Comments explain why they are absent; code must not set them.
      expect(source).not.toMatch(/^\s*temperature\s*:/m);
      expect(source).not.toMatch(/^\s*top_[pk]\s*:/m);
    }
  });
});

/* ---------------------------------------------- 2. Vercel cancellation ------ */

describe('request cancellation is enabled in production', () => {
  /**
   * The handler aborts the provider call when the browser hangs up, which is
   * how an abandoned command stops costing money. On Vercel that is opt-in per
   * path: without this configuration `request.signal` never fires, the handler
   * looks correct, and every abandoned request runs to completion and is
   * billed. Nothing in the code could reveal that, so it is asserted here.
   *
   * Verified against vercel.com/changelog/node-js-vercel-functions-now-support-
   * per-path-request-cancellation.
   */
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
    functions?: Record<string, { supportsCancellation?: boolean }>;
    headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };

  it('vercel.json enables supportsCancellation for the endpoint', () => {
    expect(config.functions?.['api/interpret.ts']?.supportsCancellation).toBe(true);
  });

  it('EVERY function in api/ has cancellation enabled, not just the first one', () => {
    // Adding an endpoint without cancellation is the realistic way this
    // silently regresses — and this test has already caught it once, when the
    // auth adapters landed.
    //
    // Recurses, because `api/auth/login.ts` is a function too. Skips the files
    // Vercel documents as NOT becoming functions: a leading underscore, a
    // leading dot, or a `.d.ts` suffix. `api/_shared.ts` is shared code, not an
    // endpoint, and requiring a config entry for it would be requiring one for
    // a route that does not exist.
    const walk = (dir: string, prefix = 'api'): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name), `${prefix}/${entry.name}`)
          : entry.name.endsWith('.ts') &&
              !entry.name.startsWith('_') &&
              !entry.name.startsWith('.') &&
              !entry.name.endsWith('.d.ts')
            ? [`${prefix}/${entry.name}`]
            : [],
      );

    const functions = walk(join(ROOT, 'api'));
    expect(functions.length).toBeGreaterThan(1);
    for (const path of functions) {
      expect(
        config.functions?.[path]?.supportsCancellation,
        `${path} is missing supportsCancellation`,
      ).toBe(true);
    }
  });

  it('the host config is served no-cache, so toggling the interpreter takes effect', () => {
    const rule = config.headers?.find((h) => h.source === '/apsis-config.js');
    expect(rule?.headers).toContainEqual({ key: 'cache-control', value: 'no-cache' });
  });

  it('every adapter stays thin — no logic migrated into the platform files', () => {
    const adapters = [
      'api/interpret.ts',
      'api/session.ts',
      'api/auth/login.ts',
      'api/auth/callback.ts',
      'api/auth/logout.ts',
    ];
    for (const path of adapters) {
      const adapter = readFileSync(join(ROOT, path), 'utf8');
      const code = adapter.split('\n').filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
      });
      // Logic that migrates here stops being covered by server/*.test.ts and
      // stops running locally.
      expect(code.length, path).toBeLessThanOrEqual(12);
      expect(adapter, path).toMatch(/from '\.\.?\/(\.\.\/)?server\//);
    }
  });
});

/* ------------------------------------------------ 3. bucket reclamation ----- */

describe('stale rate-limit buckets are actually reclaimed', () => {
  /**
   * THE BUG: cleanup read `if (perHour.length === 0)` AFTER pushing the current
   * timestamp, so the length could never be zero and the branch was
   * unreachable. Every IP an instance ever saw was retained for the life of the
   * instance — a slow leak that no test could see, because nothing exposed the
   * table's size.
   */
  it('reclaims an identity that stopped calling', () => {
    const limiter = createRateLimiter({ perMinute: 5, perHour: 10 });
    limiter.check('a', 0);
    limiter.check('b', 0);
    expect(limiter.size()).toBe(2);

    // An hour later, 'a' is back and 'b' never returned.
    limiter.check('a', HOUR + 1);
    expect(limiter.size(), 'the identity that went away must be dropped').toBe(1);
  });

  it('does not reclaim an identity that is still inside its window', () => {
    const limiter = createRateLimiter({ perMinute: 5, perHour: 10 });
    limiter.check('a', 0);
    limiter.check('b', 0);
    // Past the sweep interval but well inside the hour window: both are live.
    limiter.check('a', SWEEP + 1);
    expect(limiter.size()).toBe(2);
  });

  it('reclaims many identities at once', () => {
    const limiter = createRateLimiter({ perMinute: 5, perHour: 10 });
    for (let i = 0; i < 500; i++) limiter.check(`ip-${i}`, 0);
    expect(limiter.size()).toBe(500);
    limiter.check('someone-new', HOUR + 1);
    expect(limiter.size()).toBe(1);
  });

  it('sweeps on a schedule, not on every request', () => {
    // 1000 requests inside one sweep interval must not grow unbounded work;
    // the observable proxy is that the table is untouched until the interval
    // elapses, so a departed identity is still present just before it.
    const limiter = createRateLimiter({ perMinute: 10_000, perHour: 100_000 });
    limiter.check('gone', 0);
    for (let i = 1; i <= 1000; i++) limiter.check('busy', i);
    expect(limiter.size(), 'no sweep yet — still inside the interval').toBe(2);
    limiter.check('busy', SWEEP + HOUR + 1);
    expect(limiter.size()).toBe(1);
  });

  it('preserves the 20/minute and 200/hour semantics exactly', () => {
    const limiter = createRateLimiter({ perMinute: 20, perHour: 200 });
    for (let i = 0; i < 20; i++) {
      expect(limiter.check('ip', 1_000_000 + i).allowed, `request ${i + 1}`).toBe(true);
    }
    const blocked = limiter.check('ip', 1_000_020);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // A minute later the minute window has rolled; the hour window has not.
    expect(limiter.check('ip', 1_000_000 + MINUTE + 1).allowed).toBe(true);
  });

  it('still enforces the hourly ceiling across rolled minute windows', () => {
    const limiter = createRateLimiter({ perMinute: 2, perHour: 5 });
    let t = 0;
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      t += MINUTE + 1; // always a fresh minute window
      if (limiter.check('ip', t).allowed) allowed++;
    }
    expect(allowed, 'the hour ceiling must hold even when every minute is fresh').toBe(5);
  });

  it('a rejected request does not consume a token', () => {
    const limiter = createRateLimiter({ perMinute: 1, perHour: 10 });
    expect(limiter.check('ip', 0).allowed).toBe(true);
    for (let i = 0; i < 5; i++) limiter.check('ip', 1_000);
    // One minute on, exactly one hit should have aged out — not six.
    expect(limiter.check('ip', MINUTE + 1).allowed).toBe(true);
  });
});

const MINUTE = 60_000;
const HOUR = 3_600_000;
const SWEEP = 300_000;
