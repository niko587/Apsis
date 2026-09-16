/**
 * Cookie policy. Apsis's, not the provider's.
 *
 * Using the provider's session primitives does not mean surrendering the
 * boundary: the SDK produces an opaque sealed string, and everything about how
 * that string is carried — name, flags, lifetime, when it is cleared — is
 * decided here. No provider import.
 *
 * The sealed value is useless without `WORKOS_COOKIE_PASSWORD`, which exists
 * only on the server, so the browser holds a blob it cannot read. `HttpOnly`
 * means JavaScript cannot read it either. Note what that does NOT buy: an XSS
 * on the page can still *ride* the session, because the browser attaches the
 * cookie to same-origin requests regardless. HttpOnly prevents exfiltration,
 * not abuse while the page is compromised.
 */

/**
 * `__Host-` in production: the prefix is enforced by the browser and REFUSES
 * the cookie unless it is Secure, Path=/ and has no Domain — so a future edit
 * that weakens any of those breaks loudly instead of silently widening scope.
 * Plain name on `http://localhost`, where `Secure` is impossible.
 */
export const SESSION_COOKIE_SECURE = '__Host-apsis_session';
export const SESSION_COOKIE_PLAIN = 'apsis_session';
export const CHALLENGE_COOKIE_SECURE = '__Host-apsis_auth_challenge';
export const CHALLENGE_COOKIE_PLAIN = 'apsis_auth_challenge';

/** Seven days, sliding: re-issued whenever a refresh rotates the sealed session. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** A login that is not completed in ten minutes was abandoned. */
export const CHALLENGE_MAX_AGE_SECONDS = 600;

export const sessionCookieName = (secure: boolean) =>
  secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;

export const challengeCookieName = (secure: boolean) =>
  secure ? CHALLENGE_COOKIE_SECURE : CHALLENGE_COOKIE_PLAIN;

/**
 * Read one cookie.
 *
 * Hand-parsed because the value is an opaque sealed blob and the header format
 * is `name=value; name=value`. Values are not URL-decoded: the SDK's sealed
 * string is base64url-ish and decoding could corrupt it.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * `SameSite=Lax` is the CSRF primitive: the browser does not attach this cookie
 * to a cross-site POST at all. Combined with the endpoint's existing
 * `Origin`/`Sec-Fetch-Site` enforcement and its JSON-only content type (which
 * forces a preflight Apsis never answers), that is three independent layers.
 *
 * No `Domain` attribute, ever — a domain cookie leaks to every subdomain.
 */
export function buildCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** `Max-Age=0` with a matching name/path, which is what actually removes it. */
export const clearCookie = (name: string, secure: boolean): string =>
  buildCookie(name, '', { secure, maxAgeSeconds: 0 });

/**
 * Is this deployment served over HTTPS?
 *
 * Derived from the request rather than an environment variable so a production
 * request can never accidentally be treated as local. `x-forwarded-proto` is
 * what platform proxies set; the URL scheme is the fallback.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]!.trim() === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Where a login or logout may send the browser afterwards.
 *
 * Same-origin PATHS only. The rejected forms are the ones that actually get
 * exploited: `//evil.test` and `/\evil.test` are protocol-relative URLs that
 * many naive checks accept because they start with `/`, and an absolute URL is
 * the obvious case. Anything that is not plainly a local path becomes `/`.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  // A scheme anywhere before the first slash-segment, or a backslash used to
  // confuse a parser, is not a path we are willing to hand to a browser.
  if (/[\\]/.test(value) || /^\/[^/]*:/.test(value)) return '/';
  return value;
}

/**
 * Clear a session cookie that failed to open.
 *
 * Shared by the endpoint and the session route so a corrupt cookie cannot wedge
 * a browser into a permanent 401/signed-out loop from either direction.
 */
export const clearSessionCookie = (request: Request): string => {
  const secure = isSecureRequest(request);
  return clearCookie(sessionCookieName(secure), secure);
};
