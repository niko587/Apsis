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
 * Always 200: "are you signed in?" is a question, not an error, and answering
 * 401 would make every page load look like a failure.
 */
export async function sessionResponse(
  request: Request,
  authenticate: Authenticate | null,
): Promise<Response> {
  const result: AuthResult = authenticate ? await authenticate(request) : { status: 'anonymous' };
  return new Response(JSON.stringify(publicSessionOf(result)), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
