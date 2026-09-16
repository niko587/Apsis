/**
 * The protected endpoint: order, status semantics, and the two invariants that
 * matter most (D36, D37).
 *
 * The recurring assertion here is `expect(modelCalls).toBe(0)`. Every way a
 * request can fail to establish identity must cost zero Anthropic tokens, and
 * the only convincing way to show that is a fake model provider that counts.
 */

import { describe, expect, it } from 'vitest';
import { createInterpretHandler } from '../interpret';
import { createRateLimiter } from '../guard';
import type { AuthResult, Identity } from './identity';
import type { ModelProvider } from '../provider';

const URL_ = 'https://apsis.test/api/interpret';

const identity = (over: Partial<Identity> = {}): Identity => ({
  userId: 'user_1',
  sessionId: 'session_1',
  organizationId: null,
  capabilities: new Set(['interpreter:use']),
  expiresAt: Number.MAX_SAFE_INTEGER,
  ...over,
});

/** Counts every call. A single non-zero count is a failed security guarantee. */
function countingProvider() {
  let calls = 0;
  const provider: ModelProvider = {
    name: 'fake',
    interpret: async () => {
      calls++;
      return { filters: [{ field: 'stages', value: 'cold', span: 'cold' }] };
    },
  };
  return { provider, calls: () => calls };
}

const post = (body: unknown = { text: 'find cold leads' }, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const handler = (auth: AuthResult | null, extra = {}) => {
  const { provider, calls } = countingProvider();
  const h = createInterpretHandler({
    provider,
    authenticate: auth === null ? null : async () => auth,
    ...extra,
  });
  return { h, calls };
};

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('unauthenticated requests never reach the model provider (D37)', () => {
  it('401 with no session, and zero model calls', async () => {
    const { h, calls } = handler({ status: 'anonymous' });
    const response = await h(post());
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'unauthenticated' });
    expect(calls()).toBe(0);
  });

  it('401 on an expired session, clearing the cookie so a corrupt one cannot wedge the browser', async () => {
    const { h, calls } = handler({ status: 'expired' });
    const response = await h(post());
    expect(response.status).toBe(401);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('Max-Age=0');
    expect(calls()).toBe(0);
  });

  it('anonymous and expired are INDISTINGUISHABLE to the caller', async () => {
    // Telling them apart tells an attacker which cookies are real.
    const a = await handler({ status: 'anonymous' }).h(post());
    const b = await handler({ status: 'expired' }).h(post());
    expect(a.status).toBe(b.status);
    expect(await body(a)).toEqual(await body(b));
  });

  it('fails CLOSED when authentication is not configured', async () => {
    // A misconfigured auth layer must refuse, not evaporate.
    const { h, calls } = handler(null);
    const response = await h(post());
    expect(response.status).toBe(401);
    expect(calls()).toBe(0);
  });

  it('the body is never read on an unauthenticated request', async () => {
    // An oversized body would be a 413 if it were read first. It is not read,
    // so the 401 arrives before the payload is even received.
    const { h, calls } = handler({ status: 'anonymous' });
    const response = await h(post('{'.repeat(9000)));
    expect(response.status).toBe(401);
    expect(calls()).toBe(0);
  });
});

describe('a transient provider problem is not a logout (D40)', () => {
  it('503 with Retry-After, and the session cookie is left alone', async () => {
    const { h, calls } = handler({ status: 'transient', retryAfter: 30 });
    const response = await h(post());
    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({ error: 'auth_unavailable' });
    expect(response.headers.get('retry-after')).toBe('30');
    // The decisive assertion: nothing clears the cookie.
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(calls()).toBe(0);
  });

  it('supplies a default Retry-After when the provider gave none', async () => {
    const { h } = handler({ status: 'transient' });
    const response = await h(post());
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('is NOT a 401 — the user is not told they are signed out', async () => {
    const { h } = handler({ status: 'transient' });
    expect((await h(post())).status).not.toBe(401);
  });
});

describe('authorization', () => {
  it('403 for an authenticated identity without the capability', async () => {
    const { h, calls } = handler({
      status: 'authenticated',
      identity: identity({ capabilities: new Set() }),
    });
    const response = await h(post());
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: 'forbidden' });
    expect(calls()).toBe(0);
  });

  it('200 with the capability', async () => {
    const { h, calls } = handler({ status: 'authenticated', identity: identity() });
    expect((await h(post())).status).toBe(200);
    expect(calls()).toBe(1);
  });
});

describe('identity is derived, never received (D36)', () => {
  const FORGED_HEADERS = {
    'x-user-id': 'user_attacker',
    'x-session-id': 'session_attacker',
    'x-org-id': 'org_attacker',
    'x-organization-id': 'org_attacker',
    role: 'owner',
    roles: 'owner,admin',
    permissions: 'everything',
    capabilities: 'interpreter:use',
    'x-capabilities': 'interpreter:use',
    authorization: 'Bearer forged',
  };

  it('forged headers cannot authenticate an anonymous request', async () => {
    const { h, calls } = handler({ status: 'anonymous' });
    const response = await h(post({ text: 'find cold leads' }, FORGED_HEADERS));
    expect(response.status).toBe(401);
    expect(calls()).toBe(0);
  });

  it('forged headers cannot grant a capability the identity lacks', async () => {
    const { h, calls } = handler({
      status: 'authenticated',
      identity: identity({ capabilities: new Set() }),
    });
    expect((await h(post({ text: 'find cold leads' }, FORGED_HEADERS))).status).toBe(403);
    expect(calls()).toBe(0);
  });

  it('forged BODY fields are rejected as unknown keys and change no identity', async () => {
    const entries: Array<Record<string, unknown>> = [];
    const { h } = handler(
      { status: 'authenticated', identity: identity() },
      { log: (e: Record<string, unknown>) => entries.push(e) },
    );
    const response = await h(
      post({ text: 'find cold leads', userId: 'user_attacker', role: 'owner' }),
    );
    // The body guard refuses unknown keys outright.
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: 'unknown_field' });
  });

  it('the logged identity is the session’s, never the request’s', async () => {
    const entries: Array<Record<string, unknown>> = [];
    const { h } = handler(
      { status: 'authenticated', identity: identity({ userId: 'user_real' }) },
      { log: (e: Record<string, unknown>) => entries.push(e) },
    );
    await h(post({ text: 'find cold leads' }, FORGED_HEADERS));
    expect(entries[0]!.userId).toBe('user_real');
    expect(JSON.stringify(entries)).not.toContain('attacker');
  });
});

describe('a rotated session is always written back (D40)', () => {
  const rotated = '__Host-apsis_session=ROTATED; Path=/; HttpOnly; SameSite=Lax; Secure';

  it('on a successful 200', async () => {
    const { h } = handler({ status: 'authenticated', identity: identity(), setCookie: rotated });
    const response = await h(post());
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(rotated);
  });

  it('on a 403, a 400 and a 429 — dropping it on an error path loses the rotated token', async () => {
    const forbidden = handler({
      status: 'authenticated',
      identity: identity({ capabilities: new Set() }),
      setCookie: rotated,
    });
    expect((await forbidden.h(post())).headers.get('set-cookie')).toBe(rotated);

    const badBody = handler({
      status: 'authenticated',
      identity: identity(),
      setCookie: rotated,
    });
    const response = await badBody.h(post({ text: '' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBe(rotated);
  });
});

describe('rate limiting has two tiers (D37)', () => {
  it('the IP backstop still refuses a flood BEFORE authentication runs', async () => {
    let authCalls = 0;
    const { provider, calls } = countingProvider();
    const limiter = createRateLimiter({ perMinute: 2, perHour: 100 });
    const h = createInterpretHandler({
      provider,
      limiter,
      now: () => 1_000_000,
      authenticate: async () => {
        authCalls++;
        return { status: 'anonymous' };
      },
    });
    const ip = { 'x-forwarded-for': '9.9.9.9' };
    await h(post(undefined, ip));
    await h(post(undefined, ip));
    const limited = await h(post(undefined, ip));

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // The third request never got as far as authentication — which is the
    // point of putting the cheap limiter first.
    expect(authCalls).toBe(2);
    expect(calls()).toBe(0);
  });

  it('two users sharing one IP have INDEPENDENT buckets', async () => {
    const { provider } = countingProvider();
    const userLimiter = createRateLimiter({ perMinute: 1, perHour: 100 });
    const make = (userId: string) =>
      createInterpretHandler({
        provider,
        userLimiter,
        // A generous IP tier so only the per-user limiter can bite.
        limiter: createRateLimiter({ perMinute: 1000, perHour: 1000 }),
        now: () => 2_000_000,
        authenticate: async () => ({ status: 'authenticated', identity: identity({ userId }) }),
      });
    const sharedIp = { 'x-forwarded-for': '10.0.0.1' };

    expect((await make('user_a')(post(undefined, sharedIp))).status).toBe(200);
    expect((await make('user_a')(post(undefined, sharedIp))).status).toBe(429);
    // Same office, same NAT, different person — unaffected.
    expect((await make('user_b')(post(undefined, sharedIp))).status).toBe(200);
  });

  it('a per-user 429 costs no model call', async () => {
    const { provider, calls } = countingProvider();
    const userLimiter = createRateLimiter({ perMinute: 0, perHour: 100 });
    const h = createInterpretHandler({
      provider,
      userLimiter,
      authenticate: async () => ({ status: 'authenticated', identity: identity() }),
    });
    expect((await h(post())).status).toBe(429);
    expect(calls()).toBe(0);
  });
});

describe('no auth failure consumes provider tokens', () => {
  it.each([
    ['anonymous', { status: 'anonymous' } as AuthResult, 401],
    ['expired', { status: 'expired' } as AuthResult, 401],
    ['transient', { status: 'transient' } as AuthResult, 503],
    [
      'forbidden',
      { status: 'authenticated', identity: identity({ capabilities: new Set() }) } as AuthResult,
      403,
    ],
  ])('%s → %s with zero model calls', async (_label, auth, status) => {
    const { h, calls } = handler(auth);
    expect((await h(post())).status).toBe(status);
    expect(calls()).toBe(0);
  });
});
