/**
 * The local interpreter endpoint. `npm run dev:api`.
 *
 * A separate process from Vite on purpose: the vendor key lives here and never
 * enters the dev server, so `npm run dev` stays a process with no credential in
 * it. Vite proxies `/api` to this port (see vite.config.ts), which means the
 * browser talks to one origin in development exactly as it will in production.
 *
 * WHY VITE IS USED AS A MODULE LOADER HERE: `server/interpret.ts` imports
 * `COMMAND_SCHEMA` from `src/`, and the app's modules use extensionless
 * relative imports, which plain Node ESM cannot resolve. Rather than duplicate
 * the vocabulary or fork the handler for development — the two things this
 * milestone exists to avoid — the script borrows Vite's resolver, which is
 * already a devDependency, to load the SAME handler the deployed function runs.
 * Vite is a loader in this process, not a server; the secret stays here.
 */

import { createServer } from 'node:http';
import { createServer as createViteRunner } from 'vite';
import { devAuthenticate } from './devIdentity.mjs';

const PORT = Number(process.env.APSIS_API_PORT ?? 8787);

const runner = await createViteRunner({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

const interpretModule = await runner.ssrLoadModule('/server/interpret.ts');
const authModule = await runner.ssrLoadModule('/server/auth/provider.ts');

/**
 * Real WorkOS locally when it is configured; the fixed dev identity otherwise.
 *
 * The dev identity is INJECTED here rather than reachable from the handler,
 * which is what keeps it out of the deployed graph (D38). Passing `null` would
 * be the other honest option — it fails closed — but it would leave a
 * contributor without credentials unable to exercise the endpoint at all.
 */
const realProvider = authModule.authProviderFromEnv();
const authenticate = realProvider
  ? (request) => realProvider.authenticate(request)
  : devAuthenticate;

/** @type {(request: Request) => Promise<Response>} */
const handleInterpret = interpretModule.createInterpretHandler({ authenticate });

/** The auth routes, served only when WorkOS is actually configured. */
const authRoutes = realProvider
  ? {
      '/api/auth/login': (request) => realProvider.beginLogin(request),
      '/api/auth/callback': (request) => realProvider.completeLogin(request),
      '/api/auth/logout': (request) => realProvider.logout(request),
    }
  : {};

const sessionRoute = async (request) => {
  const { publicSessionOf } = await runner.ssrLoadModule('/server/auth/identity.ts');
  const result = await authenticate(request);
  return new Response(JSON.stringify(publicSessionOf(result)), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

/** node:http message -> Web Request. */
async function toWebRequest(req) {
  const url = `http://localhost:${PORT}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let body;
  if (hasBody) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  const controller = new AbortController();
  // A browser that hangs up must stop the model call — the same property the
  // deployed function relies on, exercised locally rather than assumed.
  req.on('aborted', () => controller.abort());

  return new Request(url, { method: req.method, headers, body, signal: controller.signal });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const route =
    path === '/api/interpret'
      ? handleInterpret
      : path === '/api/session'
        ? sessionRoute
        : authRoutes[path];

  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  try {
    const response = await route(await toWebRequest(req));
    const headers = {};
    response.headers.forEach((value, key) => {
      // `set-cookie` may legitimately appear more than once (a rotated session
      // alongside a cleared challenge); collapsing it would drop one.
      if (key === 'set-cookie') return;
      headers[key] = value;
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    // The handler is written not to throw; this is the floor under that claim.
    console.error('[apsis:api] unhandled', error instanceof Error ? error.name : 'unknown');
    res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'provider_failed' }));
  }
});

server.listen(PORT, () => {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY);
  console.log(`[apsis:api] POST http://localhost:${PORT}/api/interpret`);
  console.log(
    configured
      ? `[apsis:api] model ${process.env.APSIS_MODEL ?? 'default'} · key loaded from the environment`
      : '[apsis:api] NO ANTHROPIC_API_KEY — every request answers 502 provider_unconfigured, and the browser falls back to its grammar.',
  );
  console.log(
    realProvider
      ? '[apsis:api] auth · WorkOS (real sign-in at /api/auth/login)'
      : '[apsis:api] auth · DEV IDENTITY — local only. This code is not in the deployed bundle (D38).',
  );
});

const shutdown = async () => {
  server.close();
  await runner.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
