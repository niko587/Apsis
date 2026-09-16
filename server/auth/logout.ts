/**
 * Logout, owned by Apsis rather than by the identity provider.
 *
 * THE DEFECT THIS EXISTS FOR: the adapter used to read
 * `provider ? provider.logout(request) : unconfigured()`, so with WorkOS
 * unconfigured the entire route changed shape — a `GET` answered 302 instead of
 * 405, and a legitimate `POST` could not clear the local cookie at all. A stale
 * session could sit in a browser through a configuration outage and become
 * usable again the moment configuration returned.
 *
 * That was never an authentication bypass — `/api/interpret` fails closed — but
 * it made an explicit user action depend on a vendor being reachable, and
 * "sign me out" is exactly the action that must not.
 *
 * So the HTTP semantics live here and are provider-independent: method
 * enforcement, the same-origin check, and clearing the local cookie all happen
 * whether or not a provider exists. The adapter supplies only the
 * provider-specific half — a URL to continue through — and may supply nothing.
 *
 * The ordering is the security-relevant part: **nothing is mutated until both
 * guards have passed.** A rejected request leaves the browser exactly as it
 * found it.
 */

import { sameOrigin } from '../guard';
import { clearSessionCookie } from './cookies';
import { authProviderFromEnv } from './provider';

/**
 * The provider-specific half: where to send the browser so the session also
 * ends at the vendor. `null` means "there is no provider step", which is a
 * normal outcome, not an error.
 */
export type ProviderLogoutUrl = (request: Request) => Promise<string | null>;

export interface LogoutDeps {
  /** Omitted or null when no identity provider is configured. */
  logoutUrl?: ProviderLogoutUrl | null;
  allowedOrigin?: string;
}

const jsonError = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

export async function logoutResponse(
  request: Request,
  deps: LogoutDeps = {},
): Promise<Response> {
  /**
   * Logout mutates, so it is a POST (D42).
   *
   * Enforced here rather than in the adapter, so the answer is the same with or
   * without a provider. A `GET` that clears a session can be fired by any
   * `<img src>` on any page, and `SameSite=Lax` attaches cookies to cross-site
   * top-level GETs — which is what would make that work.
   */
  if (request.method !== 'POST') {
    return jsonError(405, 'method_not_allowed', { allow: 'POST' });
  }

  // The same policy the interpreter enforces, from the same function.
  if (!sameOrigin(request, deps.allowedOrigin)) {
    return jsonError(403, 'cross_origin');
  }

  // Past both guards: the local session ends NOW, unconditionally. Whether the
  // vendor can be reached is a separate question and must not gate this.
  const drop = clearSessionCookie(request);

  let location = '/';
  if (deps.logoutUrl) {
    try {
      location = (await deps.logoutUrl(request)) ?? '/';
    } catch {
      // The provider could not be asked. A partial logout — local session gone,
      // vendor session possibly lingering — is strictly better than none, and
      // the user sees a signed-out application either way.
      location = '/';
    }
  }

  const headers = new Headers({ location, 'cache-control': 'no-store' });
  headers.append('set-cookie', drop);
  return new Response(null, { status: 302, headers });
}

/**
 * The production logout route.
 *
 * Reads configuration here so the platform adapter stays three lines, and so
 * the composition itself is covered by server tests and runs identically in
 * local development. Note what happens with NO provider: `logoutUrl` is null,
 * every guard still applies, and the local cookie is still cleared.
 */
export function handleLogout(request: Request): Promise<Response> {
  const provider = authProviderFromEnv();
  return logoutResponse(request, {
    logoutUrl: provider ? (r) => provider.logoutUrl(r) : null,
    allowedOrigin: process.env.APSIS_ALLOWED_ORIGIN,
  });
}
