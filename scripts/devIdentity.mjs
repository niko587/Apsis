/**
 * A fixed identity, for contributors with no WorkOS credentials.
 *
 * THIS FILE IS NOT PART OF THE DEPLOYED APPLICATION, AND THAT IS THE ENTIRE
 * DESIGN (D38). It lives outside `server/`, it is imported only by
 * `scripts/dev-interpreter.mjs`, and `api/interpret.ts` has no import path that
 * can reach it — so the code is simply not present in production. There is no
 * flag to set, no variable to misconfigure, and deliberately no `?auth=off`.
 *
 * An environment check would have been the obvious alternative and is strictly
 * worse: it fails open when set wrongly, and the bypass is still sitting in the
 * bundle waiting to be reached. Absence is the only version of this that cannot
 * be misconfigured.
 *
 * `server/auth/boundary.test.ts` walks the import graph from every `api/` entry
 * point and fails if any of them can reach `scripts/`.
 */

/** @typedef {import('../server/auth/identity').AuthResult} AuthResult */

export const DEV_IDENTITY = Object.freeze({
  userId: 'dev_user',
  sessionId: 'dev_session',
  organizationId: null,
  capabilities: new Set(['interpreter:use']),
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/**
 * Always authenticated, as the same person.
 *
 * @returns {Promise<AuthResult>}
 */
export async function devAuthenticate() {
  return { status: 'authenticated', identity: DEV_IDENTITY };
}
