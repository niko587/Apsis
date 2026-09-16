/**
 * Authentication, against a fake WorkOS client.
 *
 * **No WorkOS account, no API key, no network.** The adapter talks to an
 * interface; these tests implement it. That is what makes CI credential-free
 * and what makes the failure modes — which are the whole point — reachable at
 * all: you cannot ask a real provider to time out on demand.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createWorkOSAuthProvider,
  identityFrom,
  type WorkOSAuthenticateResult,
  type WorkOSCookieSession,
  type WorkOSRefreshResult,
  type WorkOSUserManagement,
} from './provider';
import { capabilitiesFor, can } from './capabilities';
import { publicSessionOf } from './identity';
import { safeReturnTo, readCookie, buildCookie, isSecureRequest } from './cookies';

const CONFIG = {
  apiKey: 'sk_test_SECRET_KEY',
  clientId: 'client_123',
  cookiePassword: 'x'.repeat(32),
  redirectUri: 'https://apsis.test/api/auth/callback',
};

const SEALED = 'sealed-session-blob';
const ROTATED = 'sealed-session-blob-ROTATED';

const CLAIMS = {
  sessionId: 'session_abc',
  organizationId: 'org_xyz',
  role: 'admin',
  roles: ['admin'],
  permissions: ['widgets:read'],
  user: { id: 'user_abc', email: 'someone@example.com', firstName: 'Someone' },
};

interface FakeOptions {
  authenticateResult?: WorkOSAuthenticateResult;
  refreshResult?: WorkOSRefreshResult;
  authenticateThrows?: boolean;
  refreshThrows?: boolean;
  loadThrows?: boolean;
}

function fakeUserManagement(options: FakeOptions = {}) {
  const calls = { refresh: 0, authenticate: 0, logout: 0, exchange: 0 };
  const um: WorkOSUserManagement = {
    getAuthorizationUrlWithPKCE: () => ({
      url: 'https://auth.workos.test/authorize?x=1',
      state: 'STATE_FROM_SDK',
      codeVerifier: 'VERIFIER_FROM_SDK',
    }),
    authenticateWithCode: async () => {
      calls.exchange++;
      return { sealedSession: SEALED };
    },
    loadSealedSession: () => {
      if (options.loadThrows) throw new Error('cannot open');
      const session: WorkOSCookieSession = {
        authenticate: async () => {
          calls.authenticate++;
          if (options.authenticateThrows) throw new Error('boom');
          return (
            options.authenticateResult ?? { authenticated: true, ...CLAIMS }
          );
        },
        refresh: async () => {
          calls.refresh++;
          if (options.refreshThrows) throw new Error('unreachable');
          return (
            options.refreshResult ?? {
              authenticated: true,
              sealedSession: ROTATED,
              ...CLAIMS,
            }
          );
        },
        getLogoutUrl: async () => {
          calls.logout++;
          return 'https://auth.workos.test/logout';
        },
      };
      return session;
    },
  };
  return { um, calls };
}

const providerWith = (options: FakeOptions = {}) => {
  const { um, calls } = fakeUserManagement(options);
  return { provider: createWorkOSAuthProvider(CONFIG, { userManagement: um }), calls };
};

const withSession = (cookie = SEALED, secure = true) =>
  new Request(secure ? 'https://apsis.test/api/interpret' : 'http://localhost:5173/api/interpret', {
    method: 'POST',
    headers: { cookie: `${secure ? '__Host-apsis_session' : 'apsis_session'}=${cookie}` },
  });

/* ------------------------------------------------------------ mapping ----- */

describe('claims map into a canonical Identity, and nothing more', () => {
  it('keeps only what Apsis needs', () => {
    const identity = identityFrom({ authenticated: true, ...CLAIMS }, 1000, 60_000);
    expect(identity.userId).toBe('user_abc');
    expect(identity.sessionId).toBe('session_abc');
    expect(identity.organizationId).toBe('org_xyz');
    expect(identity.expiresAt).toBe(61_000);
    expect([...identity.capabilities]).toEqual(['interpreter:use']);
  });

  it('DROPS email, profile and raw roles — the cheapest privacy control is not holding data', () => {
    const identity = identityFrom({ authenticated: true, ...CLAIMS }, 0, 1);
    const dump = JSON.stringify({ ...identity, capabilities: [...identity.capabilities] });
    expect(dump).not.toContain('someone@example.com');
    expect(dump).not.toContain('Someone');
    expect(dump).not.toContain('admin');
    expect(dump).not.toContain('widgets:read');
    expect(Object.keys(identity).sort()).toEqual([
      'capabilities', 'expiresAt', 'organizationId', 'sessionId', 'userId',
    ]);
  });

  it('treats a missing organization as null rather than inventing one', () => {
    const identity = identityFrom(
      { authenticated: true, sessionId: 's', user: { id: 'u' } },
      0,
      1,
    );
    expect(identity.organizationId).toBeNull();
  });

  it('roles reach the outside world only as capabilities', () => {
    // Whatever a provider says, the answer is a capability set.
    expect([...capabilitiesFor({ role: 'viewer' })]).toEqual(['interpreter:use']);
    expect([...capabilitiesFor({})]).toEqual(['interpreter:use']);
    const identity = identityFrom({ authenticated: true, sessionId: 's', user: { id: 'u' } }, 0, 1);
    expect(can(identity, 'interpreter:use')).toBe(true);
  });
});

/* ------------------------------------------------------- authenticate ----- */

describe('authenticate', () => {
  it('anonymous when there is no cookie', async () => {
    const { provider } = providerWith();
    const result = await provider.authenticate(new Request('https://apsis.test/api/interpret'));
    expect(result.status).toBe('anonymous');
  });

  it('authenticated on a valid session, with no refresh call', async () => {
    const { provider, calls } = providerWith();
    const result = await provider.authenticate(withSession());
    expect(result.status).toBe('authenticated');
    expect(calls.refresh).toBe(0);
  });

  it('expired for every malformed-session reason the SDK reports', async () => {
    for (const reason of ['invalid_jwt', 'invalid_session_cookie', 'no_session_cookie_provided']) {
      const { provider } = providerWith({
        authenticateResult: { authenticated: false, reason },
        refreshResult: { authenticated: false, reason, retryable: false },
      });
      const result = await provider.authenticate(withSession());
      expect(result.status, reason).toBe('expired');
    }
  });

  it('expired when the cookie cannot even be opened', async () => {
    const { provider } = providerWith({ loadThrows: true });
    expect((await provider.authenticate(withSession())).status).toBe('expired');
  });
});

/* ------------------------------------------------------------- refresh ---- */

describe('refresh — the difference between an outage and a logout (D40)', () => {
  const expiredAccess: WorkOSAuthenticateResult = {
    authenticated: false,
    reason: 'invalid_jwt',
  };

  it.each(['invalid_grant', 'mfa_enrollment', 'sso_required', 'invalid_session_cookie', 'no_session_cookie_provided'])(
    'TERMINAL %s ends the session',
    async (reason) => {
      const { provider } = providerWith({
        authenticateResult: expiredAccess,
        refreshResult: { authenticated: false, reason, retryable: false },
      });
      expect((await provider.authenticate(withSession())).status).toBe('expired');
    },
  );

  it.each(['rate_limit_exceeded', 'timeout', 'server_error', 'network_error'])(
    'RETRYABLE %s keeps the session — never a logout',
    async (reason) => {
      const { provider } = providerWith({
        authenticateResult: expiredAccess,
        refreshResult: { authenticated: false, reason, retryable: true },
      });
      const result = await provider.authenticate(withSession());
      expect(result.status, reason).toBe('transient');
      // Critically: not `expired`. Nothing here clears a cookie.
      expect(result.status).not.toBe('expired');
    },
  );

  it('propagates Retry-After when the provider supplies one', async () => {
    const { provider } = providerWith({
      authenticateResult: expiredAccess,
      refreshResult: {
        authenticated: false,
        reason: 'rate_limit_exceeded',
        retryable: true,
        retryAfter: 42,
      },
    });
    const result = await provider.authenticate(withSession());
    expect(result).toEqual({ status: 'transient', retryAfter: 42 });
  });

  it('an unreachable provider is transient, not expired', async () => {
    // A THROW is not evidence the session ended.
    const { provider } = providerWith({ authenticateResult: expiredAccess, refreshThrows: true });
    expect((await provider.authenticate(withSession())).status).toBe('transient');
  });

  it('a SUCCESSFUL refresh returns the rotated sealed session to write back', async () => {
    // Dropping this loses the rotated refresh token and the NEXT refresh fails
    // terminally — a silent logout an hour later.
    const { provider } = providerWith({ authenticateResult: expiredAccess });
    const result = await provider.authenticate(withSession());
    expect(result.status).toBe('authenticated');
    if (result.status !== 'authenticated') return;
    expect(result.setCookie).toContain(ROTATED);
    expect(result.setCookie).toContain('__Host-apsis_session=');
    expect(result.setCookie).toContain('HttpOnly');
  });

  it('concurrent refreshes both succeed — no mutex, because rotation has a replay grace', async () => {
    const { provider, calls } = providerWith({ authenticateResult: expiredAccess });
    const [a, b] = await Promise.all([
      provider.authenticate(withSession()),
      provider.authenticate(withSession()),
    ]);
    expect(a.status).toBe('authenticated');
    expect(b.status).toBe('authenticated');
    // Both really did refresh; nothing serialised them.
    expect(calls.refresh).toBe(2);
  });
});

/* ---------------------------------------------------------- login flow ---- */

describe('login', () => {
  it('redirects to the SDK-generated URL and stores state + verifier in an HttpOnly cookie', async () => {
    const { provider } = providerWith();
    const response = await provider.beginLogin(
      new Request('https://apsis.test/api/auth/login?returnTo=/dashboard'),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://auth.workos.test/authorize?x=1');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-apsis_auth_challenge=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    // The verifier must never be visible to script or land in a referrer.
    expect(response.headers.get('location')).not.toContain('VERIFIER_FROM_SDK');
  });

  it.each(['//evil.test', '/\\evil.test', 'https://evil.test', 'http://evil.test', '/\\/evil.test'])(
    'refuses %s as a return target',
    (candidate) => {
      expect(safeReturnTo(candidate)).toBe('/');
    },
  );

  it('keeps a genuine local path', () => {
    expect(safeReturnTo('/dashboard?x=1')).toBe('/dashboard?x=1');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
  });
});

describe('callback', () => {
  const challengeCookie = (overrides: Record<string, unknown> = {}) =>
    `__Host-apsis_auth_challenge=${encodeURIComponent(
      JSON.stringify({
        state: 'STATE_FROM_SDK',
        codeVerifier: 'VERIFIER_FROM_SDK',
        returnTo: '/dashboard',
        ...overrides,
      }),
    )}`;

  const callback = (query: string, cookie?: string) =>
    new Request(`https://apsis.test/api/auth/callback${query}`, {
      headers: cookie ? { cookie } : {},
    });

  it('mints a NEW session and clears the challenge — session fixation has nothing to latch onto', async () => {
    const { provider, calls } = providerWith();
    const response = await provider.completeLogin(
      callback('?code=CODE&state=STATE_FROM_SDK', challengeCookie()),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');
    expect(calls.exchange).toBe(1);

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__Host-apsis_auth_challenge=') && c.includes('Max-Age=0'))).toBe(true);
    expect(cookies.some((c) => c.includes(`__Host-apsis_session=${SEALED}`))).toBe(true);
  });

  it('rejects a state mismatch without exchanging the code', async () => {
    const { provider, calls } = providerWith();
    const response = await provider.completeLogin(
      callback('?code=CODE&state=ATTACKER_STATE', challengeCookie()),
    );
    expect(response.headers.get('location')).toBe('/');
    expect(calls.exchange).toBe(0);
  });

  it('rejects a missing challenge cookie', async () => {
    const { provider, calls } = providerWith();
    const response = await provider.completeLogin(callback('?code=CODE&state=STATE_FROM_SDK'));
    expect(response.headers.get('location')).toBe('/');
    expect(calls.exchange).toBe(0);
  });

  it('rejects a corrupt challenge cookie', async () => {
    const { provider, calls } = providerWith();
    const response = await provider.completeLogin(
      callback('?code=CODE&state=STATE_FROM_SDK', '__Host-apsis_auth_challenge=not-json'),
    );
    expect(response.headers.get('location')).toBe('/');
    expect(calls.exchange).toBe(0);
  });

  it('rejects a missing code', async () => {
    const { provider, calls } = providerWith();
    const response = await provider.completeLogin(
      callback('?state=STATE_FROM_SDK', challengeCookie()),
    );
    expect(calls.exchange).toBe(0);
    expect(response.headers.get('location')).toBe('/');
  });

  it('re-validates returnTo from the challenge — a tampered cookie cannot redirect off-site', async () => {
    const { provider } = providerWith();
    const response = await provider.completeLogin(
      callback('?code=CODE&state=STATE_FROM_SDK', challengeCookie({ returnTo: '//evil.test' })),
    );
    expect(response.headers.get('location')).toBe('/');
  });

  it('never puts a secret in the redirect URL', async () => {
    const { provider } = providerWith();
    const response = await provider.completeLogin(
      callback('?code=CODE&state=STATE_FROM_SDK', challengeCookie()),
    );
    const location = response.headers.get('location') ?? '';
    expect(location).not.toContain(CONFIG.apiKey);
    expect(location).not.toContain(CONFIG.cookiePassword);
    expect(location).not.toContain(SEALED);
  });
});

describe('logout', () => {
  it('clears the local cookie AND ends the provider session', async () => {
    const { provider, calls } = providerWith();
    const response = await provider.logout(withSession());
    expect(calls.logout).toBe(1);
    expect(response.headers.get('location')).toBe('https://auth.workos.test/logout');
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes('__Host-apsis_session=') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('still clears locally when the provider cannot be reached', async () => {
    const { provider } = providerWith({ loadThrows: true });
    const response = await provider.logout(withSession());
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.getSetCookie().some((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('is harmless with no session', async () => {
    const { provider, calls } = providerWith();
    const response = await provider.logout(new Request('https://apsis.test/api/auth/logout'));
    expect(response.status).toBe(302);
    expect(calls.logout).toBe(0);
  });
});

/* ------------------------------------------------------------- cookies ---- */

describe('cookie policy is Apsis’s, not the provider’s', () => {
  it('carries every required attribute and no Domain', () => {
    const cookie = buildCookie('__Host-apsis_session', 'v', { secure: true, maxAgeSeconds: 100 });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    // A Domain cookie leaks to every subdomain.
    expect(cookie).not.toContain('Domain');
  });

  it('omits Secure only for local HTTP, and uses the unprefixed name there', () => {
    const local = new Request('http://localhost:5173/api/interpret');
    expect(isSecureRequest(local)).toBe(false);
    expect(buildCookie('apsis_session', 'v', { secure: false, maxAgeSeconds: 1 })).not.toContain('Secure');
  });

  it('treats a forwarded https proto as secure — a proxied production request is not local', () => {
    const proxied = new Request('http://internal/api/interpret', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(isSecureRequest(proxied)).toBe(true);
  });

  it('reads a cookie without mangling a sealed value', () => {
    const request = new Request('https://apsis.test/', {
      headers: { cookie: 'other=1; __Host-apsis_session=abc.def-ghi_jkl==; x=2' },
    });
    expect(readCookie(request, '__Host-apsis_session')).toBe('abc.def-ghi_jkl==');
    expect(readCookie(request, 'missing')).toBeNull();
  });
});

/* -------------------------------------------------------- what leaks ------ */

describe('the browser is told the minimum', () => {
  it('publicSessionOf exposes only id, org and capabilities', () => {
    const identity = identityFrom({ authenticated: true, ...CLAIMS }, 0, 1);
    const view = publicSessionOf({ status: 'authenticated', identity });
    expect(Object.keys(view).sort()).toEqual([
      'authenticated', 'capabilities', 'organizationId', 'userId',
    ]);
    const dump = JSON.stringify(view);
    expect(dump).not.toContain('someone@example.com');
    expect(dump).not.toContain('expiresAt');
  });

  it('says nothing at all when unauthenticated', () => {
    for (const status of ['anonymous', 'expired', 'transient'] as const) {
      expect(publicSessionOf({ status } as never)).toEqual({ authenticated: false });
    }
  });

  it('no auth route ever emits the API key or the cookie password', async () => {
    const { provider } = providerWith();
    const responses = [
      await provider.beginLogin(new Request('https://apsis.test/api/auth/login')),
      await provider.logout(withSession()),
      await provider.completeLogin(new Request('https://apsis.test/api/auth/callback')),
    ];
    for (const response of responses) {
      const dump =
        [...response.headers.entries()].map(([k, v]) => `${k}:${v}`).join('\n') +
        (await response.text());
      expect(dump).not.toContain(CONFIG.apiKey);
      expect(dump).not.toContain(CONFIG.cookiePassword);
    }
  });

  it('the PKCE verifier survives the redirect ONLY in the HttpOnly cookie', async () => {
    // It has to cross the redirect somehow, and the whole point of putting it
    // in an HttpOnly cookie is that it is unreachable from script. What must
    // never happen is it appearing in the URL, where it would land in browser
    // history, a referrer header and every proxy log on the way.
    const { provider } = providerWith();
    const response = await provider.beginLogin(new Request('https://apsis.test/api/auth/login'));

    expect(response.headers.get('location')).not.toContain('VERIFIER_FROM_SDK');
    expect(await response.text()).not.toContain('VERIFIER_FROM_SDK');

    const challenge = response.headers.getSetCookie().find((c) => c.includes('challenge'))!;
    expect(challenge).toContain(encodeURIComponent('VERIFIER_FROM_SDK'));
    expect(challenge).toContain('HttpOnly');
  });
});

describe('configuration', () => {
  it('is null unless every variable is present, and never half-wired', async () => {
    const { authProviderFromEnv } = await import('./provider');
    const full = {
      WORKOS_API_KEY: 'k',
      WORKOS_CLIENT_ID: 'c',
      WORKOS_COOKIE_PASSWORD: 'p'.repeat(32),
      WORKOS_REDIRECT_URI: 'https://apsis.test/api/auth/callback',
    };
    expect(authProviderFromEnv(full)).not.toBeNull();
    for (const key of Object.keys(full)) {
      const partial = { ...full, [key]: undefined };
      expect(authProviderFromEnv(partial), key).toBeNull();
    }
  });

  it('refuses a cookie password below the SDK minimum', async () => {
    const { authProviderFromEnv } = await import('./provider');
    expect(
      authProviderFromEnv({
        WORKOS_API_KEY: 'k',
        WORKOS_CLIENT_ID: 'c',
        WORKOS_COOKIE_PASSWORD: 'short',
        WORKOS_REDIRECT_URI: 'https://apsis.test/cb',
      }),
    ).toBeNull();
  });

  it('never calls the network when unconfigured', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { authProviderFromEnv } = await import('./provider');
    expect(authProviderFromEnv({})).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
