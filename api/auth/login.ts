/**
 * Platform adapter. Thin by contract: logic here stops being covered by
 * `server/auth/*.test.ts` and stops running in local development.
 */

import { authProviderFromEnv } from '../../server/auth/provider';
import { unconfigured } from '../_shared';

export const config = { runtime: 'nodejs' };

export default function handler(request: Request): Promise<Response> {
  const provider = authProviderFromEnv();
  return provider ? provider.beginLogin(request) : unconfigured();
}
