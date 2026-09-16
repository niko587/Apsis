/*
 * Apsis host configuration.
 *
 * INERT AS COMMITTED — AND THAT IS LOAD-BEARING.
 *
 * With nothing declared here, Apsis runs its built-in command grammar, makes no
 * network requests at all, and behaves exactly as it did before the interpreter
 * existed. The browser suite asserts that: `e2e/llm-command.spec.ts` records
 * every request the default build makes and requires the list to be empty. So
 * enabling the interpreter is a deliberate act at deploy time, never a default,
 * and never something a contributor inherits by cloning the repo.
 *
 * To enable it, uncomment the line below. The endpoint must be an origin YOU
 * operate and that holds the model credential server-side — Apsis never does
 * (docs/CONTRACT_HOST_INTERPRETER_ENDPOINT.md §F). `/api/interpret` is this
 * repo's own function, same origin, which needs no CORS.
 *
 *   window.__APSIS_COMMAND_INTERPRETER__ = { endpoint: '/api/interpret' };
 *
 * Optional: `timeoutMs` (default 4000). Keep it above the server's own 3.5s
 * deadline so the server fails first and the user never waits for a verdict
 * that was already reached.
 *
 * `?interpreter=off` in the URL forces the grammar even when this is enabled.
 *
 * Serve this file with `cache-control: no-cache` so toggling the interpreter
 * does not require a cache bust.
 */
