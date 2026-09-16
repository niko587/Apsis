/**
 * The only file that knows which platform we are on.
 *
 * Everything real lives in `server/`, written against the Web platform, so
 * moving host is replacing this file and nothing else. Keep it this thin — a
 * line of logic here is a line that stops being tested by `server/*.test.ts`
 * and stops running in local development.
 */

import { handleInterpret } from '../server/interpret';

export const config = { runtime: 'nodejs' };

export default function handler(request: Request): Promise<Response> {
  return handleInterpret(request);
}
