/**
 * Platform adapter. Thin by contract — see api/auth/login.ts.
 */

import { authProviderFromEnv } from '../server/auth/provider';
import { sessionResponse } from '../server/auth/identity';

export const config = { runtime: 'nodejs' };

export default function handler(request: Request): Promise<Response> {
  const provider = authProviderFromEnv();
  return sessionResponse(request, provider ? (r) => provider.authenticate(r) : null);
}
