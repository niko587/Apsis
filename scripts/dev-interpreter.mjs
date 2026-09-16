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

const PORT = Number(process.env.APSIS_API_PORT ?? 8787);

const runner = await createViteRunner({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

/** @type {{ handleInterpret: (request: Request) => Promise<Response> }} */
const { handleInterpret } = await runner.ssrLoadModule('/server/interpret.ts');

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
  if (!req.url?.startsWith('/api/interpret')) {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  try {
    const response = await handleInterpret(await toWebRequest(req));
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
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
});

const shutdown = async () => {
  server.close();
  await runner.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
