# Authentication and access control — architecture contract

_Written 2026-09-16 by Opus, acting as security/backend architect, after
inspecting the repository at `6b9ac89`. Binding for the implementation phase.
**Nothing here is implemented yet.**_

Apsis has exactly one protected resource: `POST /api/interpret`, which spends a
metered vendor credential. This contract is about putting an identity in front
of it — and nothing larger.

---

## A. Current threat model

What exists today (`server/guard.ts`, `server/interpret.ts`): same-origin and
`Sec-Fetch-Site` checks, an 8 KB streamed body cap, 512-character text cap,
closed key set, a coarse per-IP token bucket, request cancellation, and a
provider whose errors never reach the browser. All of it is **cost control and
input hygiene**. None of it is access control.

| threat | today | after this milestone |
|---|---|---|
| **Unauthenticated API spending** | anyone who can reach the URL can spend the key; the IP bucket is per-instance, so the real ceiling is instances × limit | identity required before the provider is called |
| **Stolen session cookie** | n/a | HttpOnly + Secure + SameSite=Lax; ≤15 min access lifetime; revocation at refresh (§D) |
| **Session fixation** | n/a | a new session is minted on every successful authentication; the pre-auth challenge cookie is cleared |
| **CSRF** | partially mitigated by accident: JSON-only content type forces a preflight, and no CORS headers are sent | made deliberate — SameSite=Lax + mandatory Origin/Sec-Fetch-Site + JSON-only (§L) |
| **XSS → auth** | n/a | no token is readable from JS; an XSS can still *ride* the session (see §E) |
| **Credential stuffing / brute force** | n/a | Apsis never sees a password; the provider owns login and its rate limiting |
| **Replayed tokens** | n/a | the login `code` is single-use at the provider; refresh tokens rotate |
| **Privilege escalation** | n/a | capabilities are derived server-side from the provider's claims, never read from the request |
| **Auth bypass via malformed headers** | n/a | identity comes only from decrypting Apsis's own sealed cookie; no header is consulted |
| **Trusting browser-supplied ids** | n/a | forbidden invariant (§H) |
| **Rate-limit bypass** | trivially, by changing IP | per-user limiting keyed on the sealed identity (§M) |
| **Logging secrets** | text/prompts/envelopes already excluded (D31) | extended to cookies, tokens, codes (§N) |
| **Enumeration** | n/a | Apsis exposes no endpoint that reveals whether an account exists |
| **Open redirect** | n/a | `returnTo` allowlisted to same-origin paths (§F) |
| **Dev bypass reaching production** | n/a | structurally impossible: the module is not in the production import graph (§O) |

**The one that matters most is the first.** Everything else in this document is
in service of it.

---

## B. Recommended auth strategy

**A managed authentication provider with a hosted sign-in page, and a session
cookie that Apsis seals itself.** No browser SDK, no password handling, and
**no Apsis-owned database**.

The comparison that decided it:

| approach | why not / why |
|---|---|
| **Roll our own sessions, stateless signed cookie** | No revocation without a store, and the contract requires revoked sessions to be rejected. Rejected. |
| **Roll our own magic link** | Genuinely DB-free if `userId = hash(email)`, but single-use enforcement needs storage, and it puts Apsis in the business of deliverability, login rate limiting and — the killer — **building organizations, invitations and roles by hand** when agencies arrive. That is a lot of security-sensitive code to own for a product whose value is elsewhere. Rejected. |
| **Platform-native (Vercel)** | Vercel Authentication protects *deployments*, not application users. Not applicable — listed because it is worth ruling out explicitly. |
| **OAuth providers directly (Google/GitHub)** | Still needs session storage and a user record, and forces every future agency onto a consumer identity. Rejected. |
| **Supabase Auth** | Comes with a Postgres database. That is *more* than this milestone needs, and adopting a platform to get a login form is the definition of painting into a corner. Revisit if and when CRM data moves server-side. Rejected for now. |
| **Managed provider, hosted page, Apsis-sealed cookie** | **Chosen.** No passwords, no user table, no browser SDK, no new dependency, and organizations/roles arrive for free when needed. |

The deciding criterion was not popularity or DX: it was **what happens when
agencies show up**. Every self-hosted path requires building org membership,
invitations and roles — and a database — at exactly the moment the product is
trying to sell. A managed provider makes that a configuration change behind one
seam.

## C. Provider choice

**WorkOS AuthKit**, for three architectural reasons specific to Apsis:

1. **Apsis keeps owning its cookie.** The flow is: hosted page → `code` →
   *server-to-server* exchange → Apsis seals its own session. Apsis's
   same-origin, server-sealed model is preserved exactly; nothing else sets a
   cookie on the domain.
2. **The claims are already the shape we need.** The access token carries `sub`,
   `sid`, `org_id`, `role` and `permissions` — organizations and roles without
   an Apsis database, which is precisely the corner we are avoiding.
3. **Agencies later mean SSO later.** SAML/SCIM is a dashboard toggle rather
   than a rewrite.

**Alternatives behind the same seam:** Clerk (better if you want drop-in React
UI and accept its SDK and its cookies) and Auth0 (if enterprise compliance
demands it). Swapping is one file — see §G.

**No new dependency.** The code exchange and refresh are HTTPS POSTs
(`fetch`), and sealing is AES-256-GCM from `node:crypto`. Apsis does not need to
verify the provider's JWT, because it never accepts one from the browser: claims
are read from a response to Apsis's own authenticated server-to-server call, and
then re-sealed into Apsis's own cookie. **If that ever changes — if Apsis
accepts a provider-issued JWT directly — it must use a vetted JOSE library and
never hand-rolled verification.** Hand-written crypto verification is the one
place "no dependencies" would be the wrong instinct.

---

## D. Session / token model

One cookie, sealed by Apsis, containing:

```ts
interface SessionPayload {
  userId: string;          // provider `sub` — opaque, stable
  sessionId: string;       // provider `sid` — for revocation and correlation
  organizationId: string | null;
  roles: string[];         // as provided; capabilities are derived, not stored
  refreshToken: string;    // rotated on every refresh
  accessExpiresAt: number; // ~15 minutes
  issuedAt: number;
}
```

- **Sealed**, not signed: AES-256-GCM with `APSIS_SESSION_SECRET` (32 bytes,
  server-only). The browser cannot read the refresh token, and a tampered cookie
  fails authentication rather than decoding to something attacker-chosen.
- **Cookie lifetime** 7 days, sliding. **Access lifetime** ~15 minutes: past it,
  the server refreshes against the provider (which is where revocation is
  enforced) and re-seals.
- **Rotation:** refresh tokens rotate on use; the re-sealed cookie carries the
  new one. A replayed old refresh token fails at the provider.
- **Revocation:** logout ends the session at the provider using `sid`, and
  clears the cookie.

**The honest limitation, stated rather than buried:** with no Apsis-owned store,
a *stolen* cookie remains usable until its access window lapses — **up to 15
minutes** — because that is when the provider is next consulted. Clearing the
cookie logs out the browser that has it, not a copy someone else holds. That is
proportionate while the protected resource is a metered API and no customer
records exist server-side. **It stops being proportionate the moment CRM data
moves server-side**, and the fix then is a revocation denylist in durable
storage — which is one of the two things that would justify a database (§I).

**Multi-tab:** the cookie is shared by tabs, so a refresh in one tab is
immediately effective in all. Concurrent refreshes are possible; the loser's
rotated token fails and it simply refreshes again. No cross-tab coordination.

---

## E. Cookie / security attributes

| attribute | value | why |
|---|---|---|
| name | `apsis_session` | no `__Host-` prefix only if a path/domain need arises; prefer `__Host-apsis_session` in production |
| `HttpOnly` | yes | **no long-lived auth secret is readable from JS** — the browser never holds a token it can leak |
| `Secure` | yes in production | required by `__Host-`; omitted only on `http://localhost` |
| `SameSite` | `Lax` | blocks cookies on cross-site POST, which is the CSRF primitive |
| `Path` | `/` | one session for the app |
| `Domain` | **unset** (host-only) | a `Domain` cookie leaks to every subdomain |
| `Max-Age` | 7 days | sliding; re-issued on refresh |

**What HttpOnly does not buy:** an XSS on the page can still *make requests* as
the user — the cookie rides along. HttpOnly prevents exfiltration of the
session, not abuse of it while the page is compromised. The real mitigations are
the existing CSP-shaped discipline (no third-party scripts, no `eval`) and a
short access lifetime. Say so rather than treating HttpOnly as a solved problem.

**No token in `localStorage`, `sessionStorage`, or JS memory. Ever.** The only
thing the browser learns about the session is what `GET /api/session` chooses to
tell it (§Q).

---

## F. Authentication flow

```
GET /api/auth/login?returnTo=/
  → generate PKCE verifier + `state`
  → seal both into a short-lived HttpOnly `apsis_auth_challenge` cookie (10 min)
  → 302 to the provider's hosted sign-in page

GET /api/auth/callback?code=…&state=…
  → open the challenge cookie; require `state` to match; clear it immediately
  → POST the code + PKCE verifier to the provider (server-to-server, API key)
  → receive user, org, roles, refresh token
  → MINT A NEW SESSION (fixation defence) and seal `apsis_session`
  → 302 to the validated `returnTo`

POST /api/auth/logout
  → end the provider session using `sid`
  → clear `apsis_session` with Max-Age=0
  → 204

GET /api/session
  → `{ authenticated: false }` or
    `{ authenticated: true, userId, organizationId, capabilities }`
```

- **`state` + PKCE** are mandatory. `state` is the CSRF defence for the redirect;
  PKCE means an intercepted `code` is useless without the verifier.
- **`returnTo` is allowlisted:** must begin with a single `/`, must not begin
  with `//` or `/\`, must not contain a scheme. Anything else becomes `/`. This
  is the open-redirect defence and it is not optional.
- **No account enumeration:** Apsis has no endpoint that takes an email. The
  provider's hosted page owns that surface and its own anti-enumeration
  behaviour.

---

## G. Authorization seam

Two small functions, mirroring the `ModelProvider` seam that already exists:

```ts
/** Everything the server knows about who is calling. Derived, never received. */
export interface Identity { … }            // §H

export interface AuthProvider {
  readonly name: string;
  /** Opens Apsis's own cookie. Refreshes against the vendor when stale. */
  authenticate(request: Request): Promise<AuthResult>;
  beginLogin(returnTo: string): Promise<Response>;
  completeLogin(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

export type AuthResult =
  | { status: 'anonymous' }
  | { status: 'expired' }
  | { status: 'authenticated'; identity: Identity; setCookie?: string };
```

Authorization is deliberately one function and one capability:

```ts
export type Capability = 'interpreter:use';

/** The ONLY place capabilities are decided. Roles enter here, not at endpoints. */
export function capabilitiesFor(claims: ProviderClaims): ReadonlySet<Capability>;

export function can(identity: Identity, capability: Capability): boolean;
```

**v1 rule: any authenticated identity gets `interpreter:use`.** No role matrix,
because there is nothing yet to differentiate. The seam is what matters: when
`owner` / `admin` / `advisor` / `viewer` and entitlements arrive, they are
expressed *inside* `capabilitiesFor`, and every endpoint keeps asking the same
question — `can(identity, '…')`. No endpoint learns what a role is.

---

## H. User identity shape

The minimum, and nothing invented:

```ts
export interface Identity {
  /** Opaque and stable. Never an email. */
  readonly userId: string;
  /** Provider session id — revocation, and the only id that appears in logs. */
  readonly sessionId: string;
  /** Carried from the first day so nothing has to be retrofitted. Null until orgs exist. */
  readonly organizationId: string | null;
  readonly capabilities: ReadonlySet<Capability>;
  readonly expiresAt: number;
}
```

No email, no display name, no profile. Apsis does not need them, and not holding
them is the cheapest privacy control available.

**Binding invariant:** `userId`, `organizationId`, roles and capabilities are
read **only** from the decrypted session cookie. A request header, query
parameter or body field carrying any of them is ignored — not rejected with a
helpful message, ignored — and a test asserts forged values change nothing.

---

## I. Future organization / tenant seam

`organizationId` is carried now and **unused**. No fake organization state is
created.

**The line that must not be crossed accidentally:** the first time a server
endpoint reads or writes data scoped to an account, tenant isolation becomes
mandatory and must come from `Identity`, never from the request. Today nothing
qualifies — the lead book is seeded client-side and `/api/interpret` is
stateless.

**The two things that will require a database**, named now so the decision is
deliberate when it arrives:

1. **Durable quotas** — per-user or per-org spend counters that survive across
   serverless instances (§M).
2. **Instant revocation** — a session denylist that closes the ≤15-minute window
   (§D).

CRM/customer records will require both, plus row-level tenant scoping. None of
it belongs in this milestone.

---

## J. Protected endpoint middleware / order

Current order in `guardRequest` is: method → origin → content-type → IP limit →
body cap → parse → shape. The new order, and the reasoning for each position:

```
1. method                      405   free
2. origin / Sec-Fetch-Site     403   free
3. content-type                415   free
4. IP rate limit               429   cheap; BEFORE auth so an unauthenticated
                                     flood is refused without decrypt work, and
                                     so session guessing is throttled
5. authenticate                401   cookie decrypt; no network in the common case
6. authorize (capability)      403
7. per-user rate limit         429   the real quota dimension
8. body size cap               413   first byte of body read only now
9. parse + shape               400
10. provider call
```

**Authentication precedes reading the body.** An unauthenticated request is
rejected before its payload is even received, which makes "unauthenticated
requests never reach the provider" structurally obvious rather than a property
to be checked at the end.

`createInterpretHandler` gains an injectable `authenticate`, exactly as it has
an injectable `provider` — that is what keeps tests credential-free and what
makes the dev bypass structural (§O).

## K. 401 / 403 semantics

| status | meaning | body |
|---|---|---|
| **401** | no session, expired, malformed, or revoked | `{"error":"unauthenticated"}` |
| **403** | valid session without the capability | `{"error":"forbidden"}` |

All four 401 causes return the **same** body and the same status. Distinguishing
"expired" from "never existed" tells an attacker which cookies are real. No
email, no account hint, no vendor message — consistent with the existing rule
that error bodies carry a code and nothing else.

A 401 may carry a `Set-Cookie` clearing a session that failed to open, so a
corrupt cookie does not wedge the browser in a loop.

## L. CSRF strategy

Three layers, and the first two already exist:

1. **`Sec-Fetch-Site` / `Origin` enforcement** — already mandatory in
   `guard.ts`.
2. **JSON-only content type** — `application/json` is not a CORS-simple request,
   so cross-origin JS cannot send it without a preflight that Apsis never
   answers.
3. **`SameSite=Lax`** — the browser does not attach the session to a cross-site
   POST at all.

For v1 that is sufficient **because every state-changing endpoint is a JSON POST
from the same origin**. Two rules keep it sufficient:

- **`GET` must never change state.** `/api/auth/login` redirects and sets only a
  challenge cookie; `/api/session` is read-only.
- **Any future endpoint that accepts form encoding, or that mutates on GET, must
  add a double-submit token before it ships.** Written down here so the
  exception is visible when someone reaches for it.

The OAuth redirect has its own CSRF defence: the `state` parameter (§F).

## M. Rate limiting after identity

**Keep the IP layer.** It is the only thing that works before identity exists,
and it is what throttles a flood of unauthenticated requests. Removing it would
mean the cheapest attack — hammering the endpoint with no cookie — is also the
least limited.

Three tiers:

| tier | key | purpose | position |
|---|---|---|---|
| IP backstop | best-effort client IP | abuse before identity | step 4 |
| per-user | `identity.userId` | the real quota; users share IPs behind office NAT, and one user roams across IPs | step 7 |
| per-org (future) | `identity.organizationId` | agency-level spend | same seam |

`createRateLimiter` is reused unchanged; only the **key** differs. The limiter's
honest per-instance limitation (D34) applies to every tier and must stay
documented — these are cost control, not quotas. **A real quota requires durable
counters**, which is §I's first database trigger.

Rate limiting stays separate from authentication: a 429 is never an auth signal
and a 401 never consumes quota.

## N. Logging and privacy

Extends D31 rather than replacing it. **Never logged, at any level:** passwords
(Apsis never sees one), session cookies or their contents, access or refresh
tokens, magic-link tokens, OAuth `code` or `state`, provider secrets, `Set-Cookie`
headers.

**Email addresses do not appear in logs at all** — Apsis does not store them in
the session, so there is nothing to leak. Identity in logs is `userId` and
`sessionId`, both opaque provider identifiers.

`LogEntry` gains exactly two optional fields:

```ts
userId?: string | null;      // opaque
sessionId?: string | null;   // opaque
```

A test asserts that a realistic session's cookie value, refresh token and
`code` never appear in any emitted log entry.

## O. Local development

Two supported modes, and the second is the interesting one.

**Real auth locally.** Point `.env.local` at the provider's development
environment; the flow is identical to production. This is the default and it is
what should be exercised before shipping.

**Dev identity, for contributors without provider credentials.** A fake
authenticator returning a fixed identity.

**It must be structurally impossible in production, and an environment check is
not structural.** So:

- The dev authenticator lives in `scripts/devIdentity.mjs` — **outside
  `server/`**.
- It is imported **only** by `scripts/dev-interpreter.mjs`, and injected via the
  `authenticate` option the handler already accepts.
- `api/interpret.ts` imports nothing from `scripts/`, so the deployed bundle
  **does not contain the code at all**. There is no flag to set, no variable to
  misconfigure, and no query parameter — `?auth=off` and every relative of it is
  forbidden.
- A test walks the import graph from `api/interpret.ts` and asserts `scripts/`
  is unreachable, so this cannot regress silently.

**Contributors need no credential to work on Apsis.** With no interpreter
declared, `public/apsis-config.js` is inert, the grammar runs, and the endpoint
is never called — the property the README already promises, unchanged.

## P. CI and test identity

CI has no provider credential and needs none.

- **Unit/server tests** inject a fake `authenticate`, exactly as they inject a
  fake `ModelProvider`. Sealing and opening a cookie is tested with a fixed test
  secret so the crypto path is genuinely exercised.
- **Browser tests** never authenticate for real: the suite already mocks
  `/api/interpret` with `page.route`, and the auth UI states are driven by
  mocking `/api/session`. No credential, no provider contact, no flake.
- The existing 48 browser tests must keep passing **unmodified**, including
  `e2e/llm-command.spec.ts`'s zero-network assertion — which remains true because
  the default build declares no interpreter and therefore never calls the API.

---

## Q. Minimal client UX

**Recommendation: gate the FEATURE, not the application (option B).**

The trade-off, stated plainly:

- **Gating the whole app** protects nothing that needs protecting today — the
  lead book is seeded client-side and contains no real customer data — while
  breaking the "no credential needed to work on Apsis" promise, forcing every
  browser test through a login, and putting a wall in front of a demo whose
  entire value is being immediately visible.
- **Gating the interpreter** protects exactly the metered resource, preserves
  every existing invariant, and keeps CI credential-free.

**The trigger for changing this is explicit:** the moment any real customer data
is served from the server — CRM records, a shared book, anything tenant-scoped —
the app-wide gate becomes mandatory. That sentence belongs in `NEXT_ACTIONS`
now, not discovered later.

Minimum states, all inside the existing command area:

| state | UI |
|---|---|
| signed out | the grammar works as always; a quiet "Sign in to use the language model" affordance appears **only when an interpreter is configured** |
| signing in | full-page redirect to the hosted page; nothing to render |
| authenticated | nothing changes visually except a small identity affordance with sign-out |
| session expired | the next command returns 401 → falls into the **existing** fallback with a note that says to sign in again |
| signing out | POST, then the affordance returns to signed out |
| 401 on a protected call | grammar result renders normally, plus the sign-in note |

The 401 path is nearly free: `resolveCommand` already treats every non-2xx as
"grammar + note", so an expired session degrades gracefully today. The only
client change needed is a **distinct note for 401** — `InterpreterUnavailableError`
must carry the status so `router.ts` can choose between "the language model was
unavailable" and "sign in to use the language model".

No live region is added; the note lives in the outcome panel as it does now.

---

## R. Files allowed to change

- **new** `server/auth/session.ts` — seal/open, cookie construction, attributes
- **new** `server/auth/provider.ts` — the `AuthProvider` seam + WorkOS impl
- **new** `server/auth/capabilities.ts` — `capabilitiesFor`, `can`
- **new** `server/auth/*.test.ts`
- `server/interpret.ts` — inject `authenticate`, the order in §J
- `server/guard.ts` — limiter keying only; existing transport guards unchanged
- **new** `api/auth/login.ts`, `api/auth/callback.ts`, `api/auth/logout.ts`,
  `api/session.ts` — thin adapters, same rule as `api/interpret.ts`
- `scripts/dev-interpreter.mjs`, **new** `scripts/devIdentity.mjs`
- `src/command/interpreter.ts`, `src/command/router.ts` — 401 note only
- `src/ui/CommandBar.tsx` — the sign-in affordance only
- `vercel.json` — `supportsCancellation` for the new functions
- `.env.example`, README, `docs/**`, new test files

## S. Files forbidden to change

`src/domain/**` (`query.ts` is still the oracle) · `src/state/**` ·
`src/universe/**` · `src/orchestrator/**` · `src/ui/**` except `CommandBar.tsx` ·
`src/command/parseInterpretation.ts` (the validator's authority is unrelated to
auth) · `e2e/llm-command.spec.ts` · `e2e/reachability.spec.ts` ·
`e2e/host-boundary.spec.ts` · `e2e/progressive-reveal.spec.ts` ·
`e2e/spatial-focus.spec.ts` · `e2e/persistence.spec.ts` · `.github/**` beyond a
job needing no secret.

**No new runtime dependency** unless §C's JOSE exception is actually triggered,
which this design avoids.

---

## T. Unit tests

1. **Unauthenticated never reaches the provider** — a fake provider asserts zero
   calls across every unauthenticated shape.
2. Valid session → 200 through `/api/interpret`.
3. Expired session → 401 (and the cookie is cleared).
4. Malformed session → 401: truncated, wrong key, flipped ciphertext bit,
   valid-JSON-but-wrong-shape, empty.
5. Revoked session → 401 at the refresh boundary.
6. **Forged identity ignored** — `x-user-id`, `x-org-id`, `role` headers and
   body fields change nothing; the identity still comes from the cookie.
7. Authenticated but lacking the capability → 403.
8. Logout → the cookie is cleared with `Max-Age=0` and the provider session is
   ended; a subsequent protected call is 401.
9. **CSRF** — cross-site `Origin` is 403 before auth runs; `state` mismatch on
   callback is rejected; a missing challenge cookie is rejected.
10. **Cookie attributes** — `HttpOnly`, `Secure` in production, `SameSite=Lax`,
    `Path=/`, no `Domain`, and `Secure` omitted only for `http://localhost`.
11. **No secret in logs** — cookie value, refresh token, `code` and `state`
    absent from every `LogEntry`; email absent because it is never stored.
12. **Per-user isolation** — two users behind one IP have independent buckets.
13. **IP backstop** — an unauthenticated flood from one IP is still limited.
14. **Auth failure consumes no provider tokens** — 401/403 paths assert zero
    provider calls and zero quota decrements.
15. `returnTo` allowlist — `//evil.test`, `/\evil.test`, `https://evil.test`,
    and a scheme-relative URL all collapse to `/`.
16. Session fixation — the session id after login differs from any pre-auth
    cookie, and the challenge cookie is cleared.
17. Sealed cookie round-trips under a test secret; a different secret fails to
    open it.
18. **No dev bypass in the production graph** — the import graph from
    `api/interpret.ts` never reaches `scripts/`.

## U. Browser tests

1. Signed out, interpreter configured → the sign-in affordance appears and the
   grammar still answers.
2. Signed out, **no** interpreter configured → nothing new appears; the default
   build is visually unchanged and still makes zero requests.
3. `/api/interpret` mocked 401 → results render from the grammar with the
   sign-in note, and the command bar stays usable.
4. `/api/session` mocked authenticated → the affordance shows signed-in state.
5. Sign-out returns the UI to signed out.
6. Keyboard reachable; no new live region.
7. **Persistence and replay unaffected** — reload restores, `?source=replay`
   stays isolated, with auth mocked in both directions.

## V. Acceptance criteria

1. No request reaches the provider without a validated identity — asserted, not
   argued.
2. Identity is derived only from Apsis's sealed cookie; forged headers and body
   fields are inert.
3. 401 and 403 are distinct, and all 401 causes are indistinguishable to the
   caller.
4. No token or session secret is readable from JavaScript or present in any log.
5. The IP backstop survives; per-user limiting is added, not substituted.
6. The default build still makes zero network requests and needs no credential.
7. CI passes with no provider credential.
8. The dev bypass is absent from the production import graph, proven by test.
9. `src/domain/**`, `src/state/**`, `src/universe/**` unchanged; the 320 unit /
   48 browser baselines hold and grow, never shrink.
10. Grammar fallback, validator authority, provider privacy boundary,
    cancellation, D32–D35, Round 7, §14, progressive reveal, persistence and
    replay all intact.

## W. Implementation sequence

1. `server/auth/session.ts` + tests — seal/open and cookie attributes first,
   with no provider and no endpoint. This is where the crypto lives; get it
   right in isolation.
2. `server/auth/capabilities.ts` + tests — trivial now, and the seam that stops
   roles leaking into endpoints later.
3. `server/auth/provider.ts` — the seam, the WorkOS implementation, PKCE,
   `state`, `returnTo` allowlist. Fake provider for tests.
4. `server/interpret.ts` — inject `authenticate`, implement §J's order. All of
   §T.1–7, 12–14 against fakes.
5. `api/auth/*` and `api/session.ts` adapters; `vercel.json` entries.
6. `scripts/devIdentity.mjs` + wiring; §T.18.
7. Client: 401-aware note, then the sign-in affordance.
8. Browser tests with mocked `/api/session`.
9. Full gates, then a real end-to-end login against the provider's dev
   environment, **reported honestly** — including whether it was actually run.

## X. Recommended implementation model

**Opus.** Session sealing, ordering, failure semantics and a threat model — no
visual component. The only UI is one affordance and one line of text.

## Y. The next implementation prompt

> **APSIS — AUTHENTICATION — IMPLEMENTATION**
>
> MODEL: OPUS HIGH. Repo `niko587/Apsis`, branch `main`, checkpoint `<current>`.
>
> Read `docs/CONTRACT_AUTHENTICATION.md` and treat it as binding. Follow §W in
> order — the sealed session and its cookie attributes first, in isolation,
> before any provider or endpoint exists.
>
> Put an identity in front of `POST /api/interpret`: a managed provider's hosted
> sign-in page, a server-to-server code exchange, and a session cookie **Apsis
> seals itself** with `node:crypto`. No browser SDK, no password handling, no
> Apsis database, **no new dependency**.
>
> **The requirement that defines the milestone (§J):** authentication runs
> *before the request body is read*, so an unauthenticated request is refused
> before its payload is received and can never reach the provider. Prove it with
> a fake provider asserting zero calls.
>
> **The requirement that defines the security posture (§H):** identity comes
> only from decrypting Apsis's own cookie. `userId`, `organizationId`, roles and
> capabilities sent by the browser are ignored, and a test asserts forged values
> change nothing.
>
> **The requirement that keeps the project workable (§O, §Q):** the dev identity
> lives outside `server/`, is imported only by `scripts/`, and is therefore
> absent from the production bundle — asserted by an import-graph test. No
> `?auth=off`. And v1 gates the **interpreter, not the application**, so the
> default build still needs no credential and still makes zero requests.
>
> Files allowed in §R, forbidden in §S. Meet every criterion in §V. Run
> TypeScript, lint, all unit/server tests, build, and the full browser suite;
> the 320/48 baselines must hold and grow.
>
> Do not begin CRM integration, billing, or a user database.
