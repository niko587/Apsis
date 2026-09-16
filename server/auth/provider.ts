/**
 * The WorkOS adapter. **The only file in the repository that imports
 * `@workos-inc/node`** — enforced by `boundary.test.ts`, because a boundary
 * nobody checks is a boundary that moves.
 *
 * WHAT THIS FILE DOES NOT DO, ON PURPOSE (D39): it does not seal or open a
 * session, verify an access JWT, store or rotate a refresh token, or handle
 * replay. All of that is the SDK's. An earlier draft of the contract had Apsis
 * hand-roll AES-256-GCM around the refresh token; that was withdrawn, because
 * session cryptography is the one area where a vetted provider implementation
 * beats code written once and reviewed by nobody.
 *
 * WHAT APSIS STILL OWNS: the cookie and its attributes (`cookies.ts`), when
 * authentication is required (`interpret.ts`), the canonical `Identity` shape
 * (`identity.ts`), what capabilities exist (`capabilities.ts`), the HTTP
 * semantics, and what the browser is allowed to know. Using the SDK is not
 * surrendering the architecture; it is declining to hand-roll the hard part.
 *
 * Every API name here was read from the published type definitions of
 * `@workos-inc/node@10.13.0`, not from prose — the docs page renders the logout
 * helper as `getLogOutUrl` while the shipped types say `getLogoutUrl`.
 */

import { WorkOS } from '@workos-inc/node';
import { capabilitiesFor } from './capabilities';
import { sameOrigin } from '../guard';
import type { AuthResult, Identity } from './identity';
import {
  CHALLENGE_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  buildCookie,
  challengeCookieName,
  clearCookie,
  isSecureRequest,
  readCookie,
  safeReturnTo,
  sessionCookieName,
} from './cookies';

export interface AuthProviderConfig {
  apiKey: string;
  clientId: string;
  /** At least 32 characters; the SDK rejects shorter. Server-only, never VITE_. */
  cookiePassword: string;
  /** Absolute URL of `/api/auth/callback`, registered with WorkOS. */
  redirectUri: string;
  /**
   * Origin allowed to POST to logout. Shares the interpreter's policy via
   * `sameOrigin`, so the two cannot drift apart.
   */
  allowedOrigin?: string;
}

/**
 * The seam. `server/interpret.ts` only ever sees `authenticate`; the rest is
 * used by the `api/auth/*` adapters.
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(request: Request): Promise<AuthResult>;
  beginLogin(request: Request): Promise<Response>;
  completeLogin(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

/* ------------------------------------------------------- SDK surface ------ */

/**
 * The slice of the SDK this adapter uses, named as an interface so tests can
 * substitute a fake and CI needs no WorkOS account. Mirrors the real types.
 */
export interface WorkOSUserManagement {
  getAuthorizationUrlWithPKCE(options: {
    provider?: string;
    redirectUri: string;
    clientId?: string;
    state?: string;
  }): Promise<{ url: string; state: string; codeVerifier: string }> | { url: string; state: string; codeVerifier: string };
  authenticateWithCode(options: {
    code: string;
    codeVerifier?: string;
    clientId?: string;
    session?: { sealSession: boolean; cookiePassword?: string };
  }): Promise<{ sealedSession?: string }>;
  loadSealedSession(options: { sessionData: string; cookiePassword: string }): WorkOSCookieSession;
}

export interface WorkOSCookieSession {
  authenticate(): Promise<WorkOSAuthenticateResult>;
  refresh(options?: {
    cookiePassword?: string;
    organizationId?: string;
  }): Promise<WorkOSRefreshResult>;
  getLogoutUrl(options?: { returnTo?: string }): Promise<string>;
}

export type WorkOSAuthenticateResult =
  | {
      authenticated: true;
      sessionId: string;
      organizationId?: string;
      role?: string;
      roles?: string[];
      permissions?: string[];
      entitlements?: string[];
      featureFlags?: string[];
      user: { id: string };
      accessToken?: string;
    }
  | { authenticated: false; reason: string };

export type WorkOSRefreshResult =
  | {
      authenticated: true;
      sealedSession?: string;
      sessionId: string;
      organizationId?: string;
      role?: string;
      roles?: string[];
      permissions?: string[];
      entitlements?: string[];
      featureFlags?: string[];
      user: { id: string };
    }
  | { authenticated: false; reason: string; retryable: boolean; retryAfter?: number };

/* ------------------------------------------------------------ mapping ----- */

/**
 * Provider claims → canonical `Identity`.
 *
 * Note everything that is DROPPED: `user` beyond its id, email, profile,
 * `accessToken`, and the raw role/permission arrays. Apsis does not need them,
 * and the cheapest privacy control available is not holding data. Roles reach
 * the outside world only as capabilities.
 */
export function identityFrom(
  result: Extract<WorkOSAuthenticateResult | WorkOSRefreshResult, { authenticated: true }>,
  now: number,
  ttlMs: number,
): Identity {
  return {
    userId: result.user.id,
    sessionId: result.sessionId,
    organizationId: result.organizationId ?? null,
    capabilities: capabilitiesFor({
      role: result.role,
      roles: result.roles,
      permissions: result.permissions,
      entitlements: result.entitlements,
      featureFlags: result.featureFlags,
    }),
    expiresAt: now + ttlMs,
  };
}

/**
 * How long a derived `Identity` is considered fresh WITHIN one request.
 *
 * Not a session lifetime — the SDK owns that. This only stops a long-running
 * handler treating an identity as valid indefinitely.
 */
const IDENTITY_TTL_MS = 5 * 60 * 1000;

export interface ProviderDeps {
  userManagement: WorkOSUserManagement;
  now?: () => number;
}

export function createWorkOSAuthProvider(
  config: AuthProviderConfig,
  deps?: ProviderDeps,
): AuthProvider {
  const um: WorkOSUserManagement =
    deps?.userManagement ??
    (new WorkOS(config.apiKey, { clientId: config.clientId })
      .userManagement as unknown as WorkOSUserManagement);
  const clock = deps?.now ?? Date.now;

  const redirect = (location: string, headers: string[]): Response => {
    const h = new Headers({ location, 'cache-control': 'no-store' });
    for (const cookie of headers) h.append('set-cookie', cookie);
    return new Response(null, { status: 302, headers: h });
  };

  return {
    name: 'workos',

    async authenticate(request: Request): Promise<AuthResult> {
      const secure = isSecureRequest(request);
      const sessionData = readCookie(request, sessionCookieName(secure));
      if (!sessionData) return { status: 'anonymous' };

      let session: WorkOSCookieSession;
      try {
        session = um.loadSealedSession({
          sessionData,
          cookiePassword: config.cookiePassword,
        });
      } catch {
        // Construction failing is an operational problem (a misconfigured
        // cookie password, say), not evidence about this user's session.
        return { status: 'transient' };
      }

      let result: WorkOSAuthenticateResult;
      try {
        result = await session.authenticate();
      } catch {
        /**
         * AN UNKNOWN THROW IS NOT EVIDENCE OF AN EXPIRED SESSION.
         *
         * The SDK reports every condition it can actually classify as a TYPED
         * `{ authenticated: false, reason }` — `invalid_jwt`,
         * `invalid_session_cookie`, `no_session_cookie_provided` — which flow
         * through the refresh path below. A throw is what is left over:
         * verification that could not be COMPLETED, such as a JWKS fetch
         * failing. Treating that as "expired" converts a WorkOS or network
         * incident into a forced logout for everyone, which is the exact
         * failure D40 exists to prevent — the reason simply arrives as an
         * exception rather than a flag.
         *
         * No error parsing here: guessing at the SDK's internals would be a
         * second, worse classifier that drifts from the real one.
         */
        return { status: 'transient' };
      }

      if (result.authenticated) {
        return {
          status: 'authenticated',
          identity: identityFrom(result, clock(), IDENTITY_TTL_MS),
        };
      }

      // The access token has expired (or the cookie is stale). Ask the
      // provider — which is the only point at which revocation is observed.
      let refreshed: WorkOSRefreshResult;
      try {
        refreshed = await session.refresh({ cookiePassword: config.cookiePassword });
      } catch {
        // A THROW is not evidence the session ended. Treat an unreachable
        // provider as transient (D40) rather than logging the user out.
        return { status: 'transient' };
      }

      if (refreshed.authenticated) {
        return {
          status: 'authenticated',
          identity: identityFrom(refreshed, clock(), IDENTITY_TTL_MS),
          // MUST be written back: the refresh token may have rotated, and
          // dropping this loses it — the next refresh would fail terminally.
          setCookie: refreshed.sealedSession
            ? buildCookie(sessionCookieName(secure), refreshed.sealedSession, {
                secure,
                maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
              })
            : undefined,
        };
      }

      // The SDK's own discrimination, and the whole point of D40: a rate limit,
      // timeout, 5xx or network error means the refresh token is likely still
      // valid. Keeping the session is the difference between an availability
      // incident and logging out every signed-in user at once.
      if (refreshed.retryable) {
        return { status: 'transient', retryAfter: refreshed.retryAfter };
      }
      return { status: 'expired' };
    },

    async beginLogin(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
      const secure = isSecureRequest(request);

      // PKCE and `state` are generated BY THE SDK — neither is hand-rolled.
      const authorization = await um.getAuthorizationUrlWithPKCE({
        provider: 'authkit',
        redirectUri: config.redirectUri,
        clientId: config.clientId,
      });

      const challenge = JSON.stringify({
        state: authorization.state,
        codeVerifier: authorization.codeVerifier,
        returnTo,
      });

      // The challenge rides in an HttpOnly cookie rather than the URL: the
      // verifier must survive the redirect without ever being visible to script
      // or landing in a referrer header or a server log.
      return redirect(authorization.url, [
        buildCookie(challengeCookieName(secure), encodeURIComponent(challenge), {
          secure,
          maxAgeSeconds: CHALLENGE_MAX_AGE_SECONDS,
        }),
      ]);
    },

    async completeLogin(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const secure = isSecureRequest(request);
      const challengeName = challengeCookieName(secure);
      const raw = readCookie(request, challengeName);

      // Always clear the challenge, on every path out of here.
      const dropChallenge = clearCookie(challengeName, secure);
      const deny = (): Response => redirect('/', [dropChallenge]);

      if (!raw) return deny();

      let challenge: { state?: string; codeVerifier?: string; returnTo?: string };
      try {
        challenge = JSON.parse(decodeURIComponent(raw)) as typeof challenge;
      } catch {
        return deny();
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      // CSRF for the redirect: a callback whose state does not match the one we
      // issued was not started by this browser.
      if (!code || !state || !challenge.state || state !== challenge.state) return deny();

      let auth: { sealedSession?: string };
      try {
        auth = await um.authenticateWithCode({
          code,
          codeVerifier: challenge.codeVerifier,
          clientId: config.clientId,
          session: { sealSession: true, cookiePassword: config.cookiePassword },
        });
      } catch {
        return deny();
      }

      if (!auth.sealedSession) return deny();

      // A NEW session is minted here and the pre-auth cookie is dropped in the
      // same response — session fixation has nothing to latch onto.
      return redirect(safeReturnTo(challenge.returnTo), [
        dropChallenge,
        buildCookie(sessionCookieName(secure), auth.sealedSession, {
          secure,
          maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
        }),
      ]);
    },

    async logout(request: Request): Promise<Response> {
      /**
       * LOGOUT IS A MUTATION, SO IT IS A POST.
       *
       * A `GET` that clears a session and calls the provider is a
       * state-changing GET: any `<img src>` or link on any page could sign a
       * user out, and none of the CSRF layers apply to it. `SameSite=Lax`
       * deliberately attaches cookies to cross-site top-level GETs, which is
       * precisely what would make that work.
       *
       * So a wrong method changes nothing at all — no cookie cleared, no
       * provider call — and says which method is allowed.
       */
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
          status: 405,
          headers: {
            allow: 'POST',
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        });
      }

      // The same policy the interpreter enforces, from the same function.
      if (!sameOrigin(request, config.allowedOrigin)) {
        return new Response(JSON.stringify({ error: 'cross_origin' }), {
          status: 403,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }

      const secure = isSecureRequest(request);
      const name = sessionCookieName(secure);
      const sessionData = readCookie(request, name);
      const drop = clearCookie(name, secure);

      if (!sessionData) return redirect('/', [drop]);

      // BOTH halves are required. Clearing the cookie alone leaves the session
      // alive at the provider, so anyone holding a copy keeps it.
      try {
        const session = um.loadSealedSession({
          sessionData,
          cookiePassword: config.cookiePassword,
        });
        const logoutUrl = await session.getLogoutUrl({ returnTo: '/' });
        return redirect(logoutUrl, [drop]);
      } catch {
        // The provider could not be asked. Still clear locally — a partial
        // logout is better than none, and the user sees a signed-out app.
        return redirect('/', [drop]);
      }
    },
  };
}

/**
 * Build from the environment, or report that no provider is configured.
 *
 * Missing configuration is `null`, never a partially-wired provider: a
 * half-configured auth system that sometimes authenticates is worse than one
 * that plainly does not exist.
 */
export function authProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthProvider | null {
  const apiKey = env.WORKOS_API_KEY;
  const clientId = env.WORKOS_CLIENT_ID;
  const cookiePassword = env.WORKOS_COOKIE_PASSWORD;
  const redirectUri = env.WORKOS_REDIRECT_URI;
  if (!apiKey || !clientId || !cookiePassword || !redirectUri) return null;
  if (cookiePassword.length < 32) return null;
  return createWorkOSAuthProvider({
    apiKey,
    clientId,
    cookiePassword,
    redirectUri,
    allowedOrigin: env.APSIS_ALLOWED_ORIGIN,
  });
}
