/**
 * Six defects found in review of the authentication milestone, each pinned.
 *
 * They share a family resemblance with the deployment-hardening round: code
 * that read correctly, had no test, and would have failed only in production or
 * only under a provider incident.
 */

import { describe, expect, it } from 'vitest';
import {
  createWorkOSAuthProvider,
  type WorkOSAuthenticateResult,
  type WorkOSCookieSession,
  type WorkOSRefreshResult,
  type WorkOSUserManagement,
} from './provider';
import { sessionResponse } from './identity';
import { clearSessionCookie } from './cookies';
import { createInterpretHandler } from '../interpret';
import type { AuthResult, Identity } from './identity';
import type { ModelProvider } from '../provider';

const CONFIG = {
  apiKey: 'sk_test_SECRET',
  clientId: 'client_1',
  cookiePassword: 'x'.repeat(32),
  redirectUri: 'https://apsis.test/api/auth/callback',
  allowedOrigin: 'https://apsis.test',
};

const SEALED = 'sealed-blob';
const ROTATED = 'sealed-blob-ROTATED';
const CLAIMS = { sessionId: 'sid_1', user: { id: 'user_1' } };

function fake(options: {
  authenticateResult?: WorkOSAuthenticateResult;
  refreshResult?: WorkOSRefreshResult;
  authenticateThrows?: boolean;
} = {}) {
  const calls = { logout: 0, refresh: 0 };
  const um: WorkOSUserManagement = {
    getAuthorizationUrlWithPKCE: () => ({ url: 'https://auth.test/x', state: 's', codeVerifier: 'v' }),
    authenticateWithCode: async () => ({ sealedSession: SEALED }),
    loadSealedSession: () => {
      const session: WorkOSCookieSession = {
        authenticate: async () => {
          if (options.authenticateThrows) throw new Error('jwks unreachable');
          return options.authenticateResult ?? { authenticated: true, ...CLAIMS };
        },
        refresh: async () => {
          calls.refresh++;
          return (
            options.refreshResult ?? { authenticated: true, sealedSession: ROTATED, ...CLAIMS }
          );
        },
        getLogoutUrl: async () => {
          calls.logout++;
          return 'https://auth.test/logout';
        },
      };
      return session;
    },
  };
  return { provider: createWorkOSAuthProvider(CONFIG, { userManagement: um }), calls };
}

const COOKIE = { cookie: `__Host-apsis_session=${SEALED}` };

const request = (method: string, headers: Record<string, string> = {}) =>
  new Request('https://apsis.test/api/auth/logout', { method, headers });

/* ------------------------------------------------ 1. logout is a mutation -- */

describe('logout is a POST, and enforces CSRF before mutating', () => {
  /**
   * A GET that clears a session and calls the provider is a state-changing GET:
   * any `<img src>` on any page could sign a user out, and `SameSite=Lax`
   * deliberately attaches cookies to cross-site top-level GETs — which is
   * exactly what would make the attack work.
   */
  it.each(['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH'])('%s cannot log out', async (method) => {
    const { provider, calls } = fake();
    const response = await provider.logout(request(method, COOKIE));

    expect(response.status, method).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    // The two things that must not have happened.
    expect(response.headers.get('set-cookie'), 'no cookie may be cleared').toBeNull();
    expect(calls.logout, 'the provider must not be called').toBe(0);
  });

  it('a same-origin POST logs out, both halves', async () => {
    const { provider, calls } = fake();
    const response = await provider.logout(
      request('POST', { ...COOKIE, origin: 'https://apsis.test', 'sec-fetch-site': 'same-origin' }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://auth.test/logout');
    expect(calls.logout).toBe(1);
    expect(response.headers.getSetCookie().some((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('a cross-site POST cannot log out', async () => {
    const crossSite: Array<Record<string, string>> = [
      { origin: 'https://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of crossSite) {
      const { provider, calls } = fake();
      const response = await provider.logout(request('POST', { ...COOKIE, ...headers }));
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(calls.logout).toBe(0);
    }
  });

  it('the session cookie is cleared ONLY on the valid flow', async () => {
    const rejected = [
      await fake().provider.logout(request('GET', COOKIE)),
      await fake().provider.logout(request('POST', { ...COOKIE, origin: 'https://evil.test' })),
    ];
    for (const response of rejected) {
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it('a non-browser POST with no Origin is allowed — curl is not an attack', async () => {
    const { provider, calls } = fake();
    const response = await provider.logout(request('POST', COOKIE));
    expect(response.status).toBe(302);
    expect(calls.logout).toBe(1);
  });
});

/* ------------------------------------- 2 & 3. /api/session correctness ----- */

describe('/api/session persists a rotated session', () => {
  /**
   * THE DEFECT: `sessionResponse` reported `authenticated: true` and threw the
   * `Set-Cookie` away. The refresh had already been consumed at WorkOS and the
   * token rotated, so the browser was left holding a superseded sealed session
   * — and the NEXT refresh would fail terminally, signing the user out for no
   * reason they could observe, minutes later and somewhere else entirely.
   */
  it('an expired access token that refreshes carries the NEW sealed session', async () => {
    const { provider, calls } = fake({
      authenticateResult: { authenticated: false, reason: 'invalid_jwt' },
    });
    const response = await sessionResponse(
      new Request('https://apsis.test/api/session', { headers: COOKIE }),
      (r) => provider.authenticate(r),
      clearSessionCookie,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authenticated: true, userId: 'user_1' });
    expect(calls.refresh).toBe(1);

    // The assertion that fails if setCookie is dropped.
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes(ROTATED)), 'the rotated session must be written back').toBe(true);
    expect(cookies.some((c) => c.includes('HttpOnly'))).toBe(true);
  });

  it('a session that needed no refresh sets no cookie', async () => {
    const { provider } = fake();
    const response = await sessionResponse(
      new Request('https://apsis.test/api/session', { headers: COOKIE }),
      (r) => provider.authenticate(r),
      clearSessionCookie,
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('/api/session does not claim signed-out on a provider problem', () => {
  const sessionWith = (result: AuthResult) =>
    sessionResponse(
      new Request('https://apsis.test/api/session', { headers: COOKIE }),
      async () => result,
      clearSessionCookie,
    );

  it('transient → 503, Retry-After, and the cookie is KEPT', async () => {
    const response = await sessionWith({ status: 'transient', retryAfter: 12 });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'auth_unavailable' });
    expect(response.headers.get('retry-after')).toBe('12');
    // The decisive assertion: nothing is cleared, and it never says false.
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('transient never reports authenticated:false', async () => {
    const response = await sessionWith({ status: 'transient' });
    const text = await response.text();
    expect(text).not.toContain('authenticated');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('anonymous → 200 authenticated:false, nothing cleared', async () => {
    const response = await sessionWith({ status: 'anonymous' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('expired → 200 authenticated:false AND the dead cookie is cleared', async () => {
    const response = await sessionWith({ status: 'expired' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    // Otherwise a corrupt cookie wedges the browser into a permanent loop.
    expect(response.headers.getSetCookie().some((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('no authenticator configured → signed out, not an error', async () => {
    const response = await sessionResponse(new Request('https://apsis.test/api/session'), null);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
  });
});

/* ----------------------------- 4. a throw is not evidence of expiry -------- */

describe('an operational throw does not log anyone out, end to end', () => {
  it('authenticate() throwing → 503, cookie untouched, zero model calls', async () => {
    let modelCalls = 0;
    const model: ModelProvider = {
      name: 'fake',
      interpret: async () => {
        modelCalls++;
        return { filters: [] };
      },
    };
    const { provider } = fake({ authenticateThrows: true });
    const handler = createInterpretHandler({
      provider: model,
      authenticate: (r) => provider.authenticate(r),
    });

    const response = await handler(
      new Request('https://apsis.test/api/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...COOKIE },
        body: JSON.stringify({ text: 'find cold leads' }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'auth_unavailable' });
    // Not signed out: the cookie survives untouched.
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(modelCalls).toBe(0);
  });
});

/* ------------------------------------- the pipeline still persists rotation */

describe('rotation survives every path out of the endpoint', () => {
  const identity: Identity = {
    userId: 'u',
    sessionId: 's',
    organizationId: null,
    capabilities: new Set(['interpreter:use']),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };

  it('a rotated cookie rides on a 200 from the real provider path', async () => {
    const { provider } = fake({ authenticateResult: { authenticated: false, reason: 'invalid_jwt' } });
    const handler = createInterpretHandler({
      provider: { name: 'fake', interpret: async () => ({ filters: [] }) },
      authenticate: (r) => provider.authenticate(r),
    });
    const response = await handler(
      new Request('https://apsis.test/api/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...COOKIE },
        body: JSON.stringify({ text: 'find cold leads' }),
      }),
    );
    expect(response.headers.getSetCookie().some((c) => c.includes(ROTATED))).toBe(true);
    void identity;
  });
});
