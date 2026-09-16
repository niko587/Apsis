/** Platform adapter. See api/auth/login.ts. */

import { authProviderFromEnv } from '../../server/auth/provider';
import { unconfigured } from '../_shared';

export const config = { runtime: 'nodejs' };

export default function handler(request: Request): Promise<Response> {
  const provider = authProviderFromEnv();
  return provider ? provider.completeLogin(request) : unconfigured();
}
