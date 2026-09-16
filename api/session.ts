/**
 * Platform adapter. Thin by contract — see api/auth/login.ts.
 */

import { authProviderFromEnv } from '../server/auth/provider';
import { sessionResponse } from '../server/auth/identity';
import { clearSessionCookie } from '../server/auth/cookies';

export const config = { runtime: 'nodejs' };

export default function handler(request: Request): Promise<Response> {
  const provider = authProviderFromEnv();
  const authenticate = provider ? (r: Request) => provider.authenticate(r) : null;
  return sessionResponse(request, authenticate, clearSessionCookie);
}
