/** Platform adapter. See api/auth/login.ts. */

import { handleLogout } from '../../server/auth/logout';

export const config = { runtime: 'nodejs' };

export default function handler(request: Request): Promise<Response> {
  return handleLogout(request);
}
