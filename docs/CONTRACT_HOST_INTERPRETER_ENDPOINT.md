# Host interpreter endpoint — architecture contract

_Written 2026-09-16 by Opus, acting as backend/security architect, after
inspecting the repository at `87161a1`. Binding for the implementation phase.
**Nothing here is implemented yet.**_

This is Apsis's **first server-side code**. Everything below is shaped by that:
the goal is the smallest boundary that makes the already-shipped client usable,
not the beginning of a backend project.

---

## 0. What already exists, and what it demands

The client half shipped at `87161a1` and is **not** to be changed by this
milestone. It already defines the whole contract:

- It activates only if a host declares
  `window.__APSIS_COMMAND_INTERPRETER__ = { endpoint, timeoutMs? }`.
- It POSTs exactly `{ text, schema }` and nothing else.
- It treats every non-2xx, timeout, malformed body and unusable envelope as
  "fall back to the grammar and say so".
- It re-validates every filter against closed vocabularies and requires each one
  to cite a span present verbatim in the user's input (D28).

**Therefore the endpoint is not a trusted component.** It cannot make Apsis do
anything the validator would not already allow, and if it disappears entirely
the product still works. That is the property to preserve, not erode.

---

## A. Runtime choice

**One HTTP function, at the same origin as the app, on Node 22.**

Same origin is the decision that removes the most machinery: no CORS preflight,
no credentials in the browser, no second hostname to configure, and
`endpoint: '/api/interpret'` works verbatim as the client already expects.

**Concrete default: Vercel Functions.** The repo is a static Vite SPA with no
server, no container, and no platform config of any kind
(`ls` finds no `vercel.json`, `netlify.toml`, `Dockerfile`, `wrangler.toml`).
Vercel serves `dist/` statically and `api/*` as functions on one origin with no
build changes, and `vercel dev` is not required because §L gives a simpler local
path.

**But the handler is not written against Vercel.** It is a standard
`(request: Request) => Promise<Response>`, which is what Vercel (Node 22),
Netlify Functions, Cloudflare Workers and Deno all accept. The platform file is
a three-line adapter. Moving hosts is deleting one file and writing another.

**Rejected:**
- *A small Node/Express API.* A second long-running process, its own deploy, its
  own origin, CORS, and a server to keep patched — for one stateless POST.
- *Cloudflare Workers as the default.* Good fit technically, and the handler will
  run there unchanged, but local development needs `wrangler` and the platform
  choice would be made before there is a reason to make it.
- *A Vite dev-server middleware plugin.* It would put the vendor key in the Vite
  process. Not a bundle leak, but it blurs exactly the line this milestone
  exists to draw, and it has no production counterpart.

---

## B. Directory structure

```
server/
  interpret.ts        handleInterpret(request: Request): Promise<Response>
  provider.ts         ModelProvider interface + createAnthropicProvider (fetch only)
  prompt.ts           system instructions + tool schema, derived from COMMAND_SCHEMA
  guard.ts            origin, method, content-type, size, rate limit
  interpret.test.ts   the whole endpoint, against a fake provider
  guard.test.ts
api/
  interpret.ts        platform adapter: `export default (req) => handleInterpret(req)`
scripts/
  dev-interpreter.mjs local server on :8787, same handler
public/
  apsis-config.js     the host declaration. Inert as committed.
```

`server/` holds everything real and imports nothing from a platform. `api/` is
the only file that knows which host we are on.

**The vocabulary is not duplicated.** `server/prompt.ts` imports `COMMAND_SCHEMA`
from `src/command/parseInterpretation.ts` — verified importable from Node: it
pulls only `src/domain/{query,types,geography}`, which are pure modules with no
DOM, no React and no store. The list the model is told about and the list the
validator enforces are then the same object, and cannot drift.

---

## C. Endpoint contract

```
POST /api/interpret
content-type: application/json
```

**Request**

```jsonc
{
  "text": "find cold leads in Tampa",   // required, 1..512 chars after trim
  "schema": { "version": 1, ... }        // sent by the client; see §H — IGNORED
}
```

**200 — an interpretation.** The envelope the client validator expects, verbatim:

```jsonc
{
  "filters": [{ "field": "stages", "value": "cold", "span": "cold" }],
  "action": "call",              // optional
  "actionSpan": "call them",     // optional; required by the client to APPLY an action
  "unmapped": ["golden retriever"]  // optional; the client validates and does not render it
}
```

A 200 whose envelope turns out to be useless is fine and expected — the client
falls back with a note. The server is not the last line of defence.

**Everything else**

| status | when | client behaviour |
|---|---|---|
| 400 | not JSON, missing/empty `text`, wrong types | grammar + note |
| 413 | body over 8 KB or `text` over 512 chars | grammar + note |
| 415 | content-type is not `application/json` | grammar + note |
| 403 | cross-origin request | grammar + note |
| 429 | rate limited (send `Retry-After`) | grammar + note |
| 502 | provider refused, errored, or returned no tool call | grammar + note |
| 504 | provider exceeded the server deadline | grammar + note |

Error bodies are `{ "error": "<code>" }` and carry **no vendor message, no
stack, no model output**. The client never renders them; they exist for `curl`.

All responses: `cache-control: no-store`, `content-type: application/json`.

---

## D. Provider interface

The smallest thing that permits a second provider without inviting a framework:

```ts
export interface ModelProvider {
  readonly name: string;
  /** Returns the model's tool-call payload as UNKNOWN. Throws on transport failure. */
  interpret(text: string, signal: AbortSignal): Promise<unknown>;
}
```

One implementation: `createAnthropicProvider({ apiKey, model, signal })`.

**No SDK — `fetch` only, server-side too.** The Messages API is one POST, the
SDK buys nothing here, and D27's invariant ("no LLM SDK may enter
`package.json`") therefore stands unamended and unqualified. Zero new
dependencies, zero supply-chain surface around a credential.

A second provider is a second file implementing two methods. Do not build a
registry, a plugin loader, or a capability negotiation layer.

---

## E. Model recommendation

**Default: `claude-haiku-4-5-20251001` (Haiku 4.5).**

The task is short: one sentence in, a small constrained JSON object out, over a
closed vocabulary that is handed to the model in full. It needs reliable
structured output, strong instruction following, low latency and low cost — and
explicitly does **not** need frontier reasoning, because there is nothing to
reason about beyond mapping phrases onto a list the prompt contains. Haiku 4.5
is the small, fast tier of the current generation and is the right default for a
call that sits in front of a user waiting for a command to run, inside a 4-second
client budget.

**Escalation path: `claude-sonnet-5`**, selected by changing `APSIS_MODEL` — one
environment variable, no code change, no redeploy of the client. If field
evidence shows Haiku mis-mapping paraphrases that matter, switch and measure.

Do not hardcode the model id anywhere but the default value of that env var.

---

## F. Server-side secret handling

- `ANTHROPIC_API_KEY` exists **only** as a platform environment variable and in
  a gitignored `.env.local` for development.
- **Never prefixed `VITE_`**, never read through `import.meta.env`, never
  imported by anything under `src/`. Vite only inlines `VITE_`-prefixed values,
  so the prefix is the whole boundary — and `src/` must contain no reference to
  the key under any name.
- `.gitignore` gains `.env.local` and `.env*.local` **before** any key is
  created locally.
- The key is read once at handler start via `process.env` and passed as an
  argument. It is never logged, never placed in a response, never included in an
  error message, and never returned to the client even in a 502.
- A missing key is a startup-visible `502 provider_unconfigured` — never a
  fallback to an unauthenticated call, never a silent success.
- CI has no key and needs none: every server test uses a fake provider (§P).

**The proof, not the promise:** the existing bundle scan already asserts zero
occurrences of `api_key`, `apiKey`, `sk-`, `Authorization`, `x-api-key`,
`openai`, `anthropic`, `VITE_` in `dist/assets/*.js`. That scan becomes a test
(§P.11) so it runs every time rather than when someone remembers.

---

## G. Structured-output strategy

**Do not rely on prompting.** Constrain the output structurally at the provider
boundary:

- Declare exactly one tool, `emit_interpretation`, whose `input_schema` is a
  JSON Schema of the envelope in §C — `filters` with `field` as an `enum` of the
  eight allowed keys, `span` as a required string, plus optional `action`
  (enum of four), `actionSpan`, `unmapped`.
- Set `tool_choice: { type: "tool", name: "emit_interpretation" }`, so the model
  cannot answer in prose.
- `temperature: 0`, `max_tokens: 1024`.
- The schema is generated from `COMMAND_SCHEMA` (§B), so the enum the model is
  constrained to *is* the enum the validator enforces.

The server returns the tool call's `input` object. If there is no `tool_use`
block, that is a `502` — not an attempt to salvage prose.

**This is a narrowing, not a guarantee.** Schema-constrained decoding still
permits a valid-shaped lie: a real `field`, a real-looking `value`, and a `span`
the user never typed. That is precisely what the client validator exists for,
and why it stays authoritative (§0).

---

## H. Validation — both directions are untrusted

**Inbound, from the browser:**

1. Method `POST` only; anything else `405`.
2. `content-type: application/json`; otherwise `415`.
3. Body read with a hard 8 KB cap — enforced by reading with a limit, not by
   parsing first and measuring after.
4. `text` must be a string, 1–512 characters after trimming. Commands are
   sentences; 512 is generous and makes cost-amplification uninteresting.
5. **`schema` is ignored.** This is the answer to "unexpected schema injection":
   the server builds its prompt from its own pinned copy and never from anything
   the client sent. It may read `schema.version` to detect a stale client, and a
   mismatch is simply a `400` — the client falls back and the user keeps
   working. A client-supplied vocabulary must never reach the model.
6. Reject unknown top-level keys rather than ignoring them silently, so a client
   that starts sending more is noticed.

**Outbound, from the model:**

1. There must be a `tool_use` block with an object `input`; otherwise `502`.
2. `filters` must be an array; cap it at **32 entries** and drop the rest. An
   unbounded array is a cheap way to make the client loop.
3. Cap each `span` at 200 characters and each string `value` at 100.
4. Shape only. **Do not re-implement the client's semantic validation on the
   server.** Two validators that are supposed to agree will eventually disagree,
   and the browser's is the one that governs what reaches `LeadQuery`. The
   server trims obvious abuse; the client decides truth.

---

## I. Privacy and the data boundary

**May leave the browser and reach the provider:**
- the user's command text
- the static vocabulary (stages, segments, ~85 city names, 51 state codes,
  numeric bounds) — schema, not records

**Must never:** any `Lead`, name, phone, email, score, intent, segment
*assignment*, coverage, occupation, event, the feed, the persisted log, counts,
or anything derived from store state. There is no code path by which the book
could reach the request body — the payload is a pure function of the command
text — and a test asserts it against a 500-lead seeded book.

**Logging policy — the part that is easy to get wrong.**

- **Never log `text` by default.** The user may type a person's name into it
  ("find the Moreau lead"). A command log is a PII log wearing a different hat.
- **Never log model output, prompts, or any part of the envelope.**
- Log per request: timestamp, request id, outcome code, total latency, provider
  latency, input/output token counts, model id, and an error *class* (not
  message).
- Opt-in `APSIS_LOG_TEXT=1` may log text for debugging. It must be documented as
  off by default, refuse to enable in production, and be paired with an explicit
  retention note. Do not ship it enabled.
- Vendor-side retention is a real exposure with a real answer: state in the
  README which provider is used, that command text is sent to it, and that no
  customer records are.

---

## J. Rate limiting and abuse protection

**Say the uncomfortable thing first:** an unauthenticated endpoint backed by a
metered vendor key is a resource anyone who can reach it can spend. Nothing in
this milestone changes that. The mitigations below are cost control and friction,
**not** access control, and the milestone is not finished until the README says
so plainly.

Layered, cheapest first:

1. **Same-origin only.** Reject when `Origin` is present and is not the
   configured origin, and when `Sec-Fetch-Site` is present and is not
   `same-origin`. Blocks casual cross-site reuse; blocks nothing scripted.
2. **Size caps** (§H) — bounds the cost of any single request.
3. **Per-IP token bucket in the function**, e.g. 20/minute and 200/hour, keyed on
   the platform's client-IP header. **Document honestly that serverless
   instances do not share memory**, so this is a coarse per-instance limit rather
   than a global guarantee.
4. **Platform rate limiting** (Vercel Firewall / Cloudflare) as the actual
   enforcement layer, configured at deploy.
5. **A hard monthly spend cap at the vendor.** The only control that cannot be
   argued with.

**Prompt injection.** The model's only untrusted input is the user's own
sentence, because no lead data is ever sent — so this is a user injecting into
their own session, and the worst outcome is a command they could have typed
anyway. The structural bounds hold regardless: forced tool use means output is
schema-shaped; the client's closed field set and vocabularies mean no invented
filter survives; and `actionSpan` provenance (D28) means an action is applied
only if its verb appears in what the user actually typed. **The blast radius is
set by the validator, not by the prompt** — which is the reason the prompt is
allowed to be simple.

Wrap the command in a delimited block and instruct the model that its contents
are data to be mapped, never instructions to follow. Treat that as defence in
depth, not as the defence.

**Before any genuinely public deployment**, add authentication. That is the next
milestone, not this one, and the contract should say so rather than implying the
gap is closed.

---

## K. Timeout and error semantics

A budget ladder, tightest first, so each layer fails before the one outside it:

| layer | budget |
|---|---|
| provider call (server → vendor) | 3000 ms, `AbortSignal` |
| server handler total | 3500 ms → `504` |
| client (`timeoutMs`) | 4000 ms (existing default) |

The client's timeout must never be the first to fire on a slow model; if it
does, the user waits the full 4 s for something the server already knew at 3 s.

- Propagate the browser's disconnect (`request.signal`) to the provider call, so
  an abandoned command stops costing money mid-flight.
- **No retries.** The client already has a correct fallback, and a retry doubles
  worst-case latency inside a budget that is already tight.
- Every failure path returns a status from §C. The handler must have no branch
  that can throw out of the top — an unhandled error is a `500` the client
  treats like any other failure, but it should be unreachable.

---

## L. Local development

Secrets never touch Vite. Two processes, one origin, via a proxy.

**One-time setup**

```bash
echo ".env.local"   >> .gitignore
echo ".env*.local"  >> .gitignore

cat > .env.local <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
APSIS_MODEL=claude-haiku-4-5-20251001
APSIS_ALLOWED_ORIGIN=http://localhost:5173
EOF
```

`vite.config.ts` gains a proxy — no secret, just a route:

```ts
server: { proxy: { '/api': 'http://localhost:8787' } }
```

**Enable the client locally** by editing `public/apsis-config.js`:

```js
window.__APSIS_COMMAND_INTERPRETER__ = { endpoint: '/api/interpret' };
```

**Daily flow**

```bash
npm run dev:api     # node --env-file=.env.local scripts/dev-interpreter.mjs  (:8787)
npm run dev         # vite (:5173), proxying /api → :8787
```

Node 22 has `--env-file` built in, so no `dotenv` dependency is added.

**Without a key**, `npm run dev` alone is the current experience, unchanged:
`apsis-config.js` as committed declares nothing, so the grammar runs and nothing
is requested. Contributors need no credential to work on Apsis.

**Playwright is unaffected.** `e2e/llm-command.spec.ts` mocks the endpoint with
`page.route` and never needs a server or a key, which is why CI stays green
without secrets.

---

## M. Deployment

1. Vercel project on the repo; build `npm run build`, output `dist/`.
2. `ANTHROPIC_API_KEY`, `APSIS_MODEL`, `APSIS_ALLOWED_ORIGIN` as Production
   environment variables. Never in the repo.
3. `api/interpret.ts` is picked up automatically at `/api/interpret`.
4. **Activation is a deliberate deployment act:** edit `public/apsis-config.js`
   to declare the endpoint. Serve it `cache-control: no-cache` so toggling the
   interpreter does not require a cache bust.
5. Configure platform rate limiting and the vendor spend cap **before** the first
   public URL exists.

**Why `public/apsis-config.js` and not an inline tag in `index.html`:** the
committed default must stay inert, because 44 browser tests assert that the
default build makes zero network requests. A separate file keeps the bundle
byte-identical across environments and makes "is the interpreter on?" a
one-line, greppable answer.

Netlify and Cloudflare are supported by replacing `api/interpret.ts` with the
equivalent adapter; `server/` does not change.

---

## N. Files allowed to change

- **new** `server/**` (handler, provider, prompt, guard, tests)
- **new** `api/interpret.ts`
- **new** `scripts/dev-interpreter.mjs`
- **new** `public/apsis-config.js`
- `index.html` — one `<script src="/apsis-config.js"></script>` before the module
- `vite.config.ts` — the `/api` dev proxy only
- `package.json` — `dev:api` script only. **No new dependency.**
- `.gitignore` — `.env.local`, `.env*.local`
- `README.md`, `docs/**`

## O. Files forbidden

**All of `src/**`.** The client is finished and its behaviour is pinned by 44
browser tests and 229 unit tests; if this milestone needs to change it, the
design is wrong and the contract should be revised first rather than the code
quietly widened. Also forbidden: `src/domain/query.ts` (still the oracle),
`e2e/llm-command.spec.ts` (it must keep passing unchanged, which is what proves
the client is indifferent to the server), `.github/**` beyond adding a job that
needs no secret, and any new runtime dependency.

---

## P. Tests

Server tests use a **fake provider** and run in vitest alongside the rest. No
network, no key, no vendor contact in CI.

1. **Valid interpretation** — a request yields a 200 whose body is the fake
   provider's tool payload, unchanged.
2. **Unsupported language** — the model maps nothing; the endpoint still returns
   200 with an empty `filters`, and the client's fallback (already tested) takes
   over.
3. **Malformed request** — non-JSON, missing `text`, `text` not a string, empty
   after trim, unknown top-level key ⇒ 400.
4. **Oversized request** — 9 KB body ⇒ 413; `text` of 513 chars ⇒ 413. Assert the
   body was rejected *without* being parsed in full.
5. **Model timeout** — provider that never resolves ⇒ 504 within the deadline,
   and the abort signal was raised on the provider call.
6. **Provider failure** — provider throws / returns non-2xx ⇒ 502, and the
   response body contains no vendor message.
7. **Malformed provider output** — no `tool_use` block, `input` not an object,
   `filters` not an array ⇒ 502 or a trimmed 200; never a 500.
8. **Unsupported fields** — a model filter naming `leads` or `__proto__` passes
   through the server untouched and is rejected by the client validator. Assert
   end-to-end through `parseInterpretation`, so the two halves are tested as one.
9. **Missing spans** — a filter with no span survives the server and dies at the
   client. Same end-to-end assertion.
10. **Rate limit** — the 21st request in a minute from one IP ⇒ 429 with
    `Retry-After`; a different IP is unaffected.
11. **No secret reaches the bundle** — build and grep `dist/assets/*.js` for
    `api_key`, `apiKey`, `sk-`, `Authorization`, `x-api-key`, `openai`,
    `anthropic`, `VITE_`. Also assert no file under `src/` references
    `ANTHROPIC_API_KEY`.
12. **No lead data reaches the provider** — capture the outbound provider request
    and assert against a 500-lead seeded book that no name, phone, email, id or
    occupation appears, and that the request is a pure function of the text.
13. **Client fallback still works when the endpoint is unavailable** — the
    existing `e2e/llm-command.spec.ts` must pass **unchanged**, including the
    500, timeout and zero-request cases.
14. **Origin** — a cross-origin `Origin` header ⇒ 403; same-origin and
    origin-less (curl) requests are allowed.
15. **Client schema is ignored** — a request carrying a tampered `schema` with
    invented vocabulary produces a provider call built from the server's own
    copy. This is the schema-injection test and it must assert on the outbound
    prompt, not on the response.

---

## Q. Acceptance criteria

1. `ANTHROPIC_API_KEY` exists only server-side; §P.11 passes; nothing under
   `src/` mentions it.
2. No new runtime dependency. `fetch` on both sides. D27 stands unamended.
3. The handler is a plain `Request → Response`; the only platform-aware file is
   `api/interpret.ts`.
4. The endpoint never returns a vendor message, stack, prompt or key in any
   response.
5. The client's `schema` never reaches the model.
6. Output is constrained by forced tool use, not by prompting alone.
7. Every §C status is reachable and produces the documented client behaviour.
8. Server deadline fires before the client's; no retries.
9. Command text and model output are absent from logs by default.
10. Rate limiting exists, and its per-instance limitation is documented rather
    than overstated.
11. `src/**` is unchanged and the full suite — 229 unit, 44 browser — is green
    without a key.
12. With `public/apsis-config.js` inert (as committed), the default build still
    makes zero network requests.
13. The README states plainly that the endpoint is unauthenticated, that command
    text reaches the provider, and that authentication is the next milestone.

---

## R. Implementation sequence

1. `.gitignore` entries **first**, before any key exists on disk.
2. `server/prompt.ts` — tool schema derived from `COMMAND_SCHEMA`, system
   instructions. Unit-test the generated schema against the eight allowed fields.
3. `server/guard.ts` + tests — method, content-type, size, origin, rate limit.
   Pure functions over a `Request`; no provider involved.
4. `server/provider.ts` — the interface and the Anthropic `fetch` implementation,
   with a fake provider for tests.
5. `server/interpret.ts` — compose guard → provider → shape-trim → response.
   All of §P.1–10, 12, 14, 15 against the fake.
6. `api/interpret.ts` adapter and `scripts/dev-interpreter.mjs`.
7. `public/apsis-config.js` (inert) + the `index.html` tag + the Vite proxy.
   Re-run the browser suite to prove §Q.12.
8. `package.json` `dev:api`; README section; §P.11 as a test.
9. Full gates, then a manual end-to-end with a real key, reported honestly —
   including latency and token counts for a handful of real commands.

---

## S. The next implementation prompt

> **APSIS — HOST INTERPRETER ENDPOINT — IMPLEMENTATION**
>
> MODEL: OPUS HIGH. Repo `niko587/Apsis`, branch `main`, checkpoint `<current>`.
>
> Read `docs/CONTRACT_HOST_INTERPRETER_ENDPOINT.md` and treat it as binding.
> Follow the sequence in §R — `.gitignore` first, then the prompt schema, then
> the guards, then the provider, then the handler.
>
> Build the endpoint the already-shipped client expects: `POST /api/interpret`,
> same origin, Node 22, a plain `Request → Response` handler in `server/` with a
> three-line platform adapter in `api/`. Anthropic via `fetch` with forced tool
> use — **no SDK, no new dependency** (§D). Default model
> `claude-haiku-4-5-20251001`, selected by `APSIS_MODEL`.
>
> **The security requirement is §F and §H:** the key is server-side only and
> never `VITE_`-prefixed; the client's `schema` is ignored and the prompt is
> built from the server's own pinned copy; body and text are size-capped before
> parsing; both browser input and model output are untrusted. Never return a
> vendor message, prompt or key to the client.
>
> **The privacy requirement is §I:** only the command text and the static
> vocabulary reach the provider, and neither the command text nor the model
> output is logged by default.
>
> **The requirement that proves the design is §Q.11–12:** `src/**` is unchanged,
> the full suite (229 unit, 44 browser) passes **without a key**, and the default
> build still makes zero network requests because `public/apsis-config.js` ships
> inert. `e2e/llm-command.spec.ts` must pass unmodified — it is the proof that
> the client does not care whether this endpoint exists.
>
> Files allowed in §N, forbidden in §O. Meet every acceptance criterion in §Q.
> Say plainly in the README that the endpoint is unauthenticated and that
> authentication is the next milestone.
>
> Do not begin authentication, agent execution, or any CRM backend.
