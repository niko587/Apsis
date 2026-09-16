/**
 * Who is calling, expressed without reference to any provider.
 *
 * This file must never import `@workos-inc/node`. It is the vocabulary
 * `server/interpret.ts` speaks, and the whole point of the seam is that the
 * endpoint cannot tell which identity provider is behind it — swapping WorkOS
 * for anything else touches `provider.ts` and nothing that reads this.
 *
 * D36: identity is DERIVED, never RECEIVED. Every field below comes from a
 * session the server validated. Nothing here is ever populated from a header,
 * a query parameter or a request body, and the endpoint has no code path that
 * could do so.
 */

/**
 * v1 has exactly one capability, because there is exactly one thing to protect.
 *
 * Roles and permissions do not appear in this type on purpose. When `owner`,
 * `admin`, `advisor` and `viewer` arrive they are translated into capabilities
 * inside `capabilitiesFor` — so endpoints keep asking one question and never
 * learn what a role is.
 */
export type Capability = 'interpreter:use';

export interface Identity {
  /** Opaque and stable. Never an email, never a display name. */
  readonly userId: string;
  /** The provider's session id. The only other id allowed into logs. */
  readonly sessionId: string;
  /** Carried from day one so nothing has to be retrofitted. Null until orgs exist. */
  readonly organizationId: string | null;
  readonly capabilities: ReadonlySet<Capability>;
  /** Epoch ms after which this identity should not be trusted without a refresh. */
  readonly expiresAt: number;
}

/**
 * The four answers authentication can give, and the three different HTTP
 * outcomes they map to.
 *
 * `transient` is the one that earns its place. A provider timeout, 429 or 5xx
 * means the session is *probably fine* and we simply could not check right now
 * — reporting that as `expired` would log out every signed-in user during an
 * outage, turning an availability incident into a credential incident (D40).
 */
export type AuthResult =
  /** No session cookie at all. → 401 */
  | { status: 'anonymous' }
  /** A session that is over: malformed, invalid, or terminally refused. → 401, clear the cookie */
  | { status: 'expired' }
  /** We could not reach the provider to check. → 503, KEEP the cookie */
  | { status: 'transient'; retryAfter?: number }
  /** Verified. `setCookie` carries a rotated sealed session that MUST be written back. */
  | { status: 'authenticated'; identity: Identity; setCookie?: string };

/** The shape `server/interpret.ts` depends on. One function, no provider types. */
export type Authenticate = (request: Request) => Promise<AuthResult>;

/**
 * What `GET /api/session` is allowed to tell the browser.
 *
 * Deliberately not `Identity`: no `expiresAt` (invites client-side expiry logic
 * that will disagree with the server), and nothing from the provider. The UI
 * needs to know whether to show a sign-in affordance, and nothing else.
 */
export interface PublicSession {
  authenticated: boolean;
  userId?: string;
  organizationId?: string | null;
  capabilities?: string[];
}

export const publicSessionOf = (result: AuthResult): PublicSession =>
  result.status === 'authenticated'
    ? {
        authenticated: true,
        userId: result.identity.userId,
        organizationId: result.identity.organizationId,
        capabilities: [...result.identity.capabilities],
      }
    : { authenticated: false };

/**
 * The `GET /api/session` response.
 *
 * Lives here rather than in the platform adapter so it is covered by server
 * tests and runs identically in local development — the adapter stays a
 * three-line shim, which is the rule that keeps logic out of `api/`.
 *
 * TWO THINGS THIS MUST GET RIGHT, both learned the hard way:
 *
 * 1. **A rotated session has to be written back.** `authenticate()` may have
 *    refreshed and rotated the sealed session on the way through. Returning
 *    `authenticated: true` while dropping that `Set-Cookie` consumes the
 *    rotation and leaves the browser holding a superseded token — the next
 *    refresh then fails terminally and the user is signed out for no reason
 *    they could observe. The interpreter endpoint already does this; so does
 *    this one.
 *
 * 2. **`transient` is not `authenticated: false`.** A WorkOS timeout, 429, 5xx
 *    or network failure is not proof of a logout, and reporting one as "signed
 *    out" makes the UI throw away a perfectly good session and show a sign-in
 *    link during an outage. It answers 503 and keeps the cookie (D40).
 */
export async function sessionResponse(
  request: Request,
  authenticate: Authenticate | null,
  /** Clears a terminally invalid cookie so a corrupt one cannot wedge the browser. */
  clearSession?: (request: Request) => string,
): Promise<Response> {
  const result: AuthResult = authenticate ? await authenticate(request) : { status: 'anonymous' };

  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });

  if (result.status === 'transient') {
    headers.set('retry-after', String(Math.max(1, Math.ceil(result.retryAfter ?? 5))));
    // Note what is NOT here: no Set-Cookie. The session is untouched.
    return new Response(JSON.stringify({ error: 'auth_unavailable' }), {
      status: 503,
      headers,
    });
  }

  if (result.status === 'authenticated' && result.setCookie) {
    headers.append('set-cookie', result.setCookie);
  }
  if (result.status === 'expired' && clearSession) {
    headers.append('set-cookie', clearSession(request));
  }

  return new Response(JSON.stringify(publicSessionOf(result)), { status: 200, headers });
}
