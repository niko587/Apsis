/**
 * Shared by the auth adapters. Underscore-prefixed so the platform does not
 * turn it into a function of its own.
 */

/**
 * Authentication is not configured.
 *
 * A redirect to `/`, not a helpful error: an unconfigured deployment should
 * look like an app without sign-in, not like one whose auth is broken in a way
 * worth probing.
 */
export const unconfigured = (): Promise<Response> =>
  Promise.resolve(
    new Response(null, {
      status: 302,
      headers: { location: '/', 'cache-control': 'no-store' },
    }),
  );
