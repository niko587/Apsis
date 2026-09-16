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
| **Stolen session cookie** | n/a | HttpOnly + Secure + SameSite=Lax; usable only until the provider-configured access-token lifetime lapses; revocation at refresh (§D.1) |
| **Session fixation** | n/a | a new session is minted on every successful authentication; the pre-auth challenge cookie is cleared |
| **CSRF** | partially mitigated by accident: JSON-only content type forces a preflight, and no CORS headers are sent | made deliberate — SameSite=Lax + mandatory Origin/Sec-Fetch-Site + JSON-only (§L) |
| **XSS → auth** | n/a | no token is readable from JS; an XSS can still *ride* the session (see §E) |
| **Credential stuffing / brute force** | n/a | Apsis never sees a password; the provider owns login and its rate limiting |
| **Replayed tokens** | n/a | the login `code` is single-use at the provider; PKCE binds it to this browser; refresh tokens rotate with a replay grace period (§D.1) |
| **Privilege escalation** | n/a | capabilities are derived server-side from the provider's claims, never read from the request |
| **Auth bypass via malformed headers** | n/a | identity comes only from the SDK opening Apsis's sealed cookie; no header is consulted |
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

**A managed authentication provider with a hosted sign-in page, whose sealed
session Apsis carries in a cookie it owns and controls.** No browser SDK, no
password handling, **no Apsis-owned database**, and no session cryptography
written here.

The comparison that decided it:

| approach | why not / why |
|---|---|
| **Roll our own sessions, stateless signed cookie** | No revocation without a store, and the contract requires revoked sessions to be rejected. Rejected. |
| **Roll our own magic link** | Genuinely DB-free if `userId = hash(email)`, but single-use enforcement needs storage, and it puts Apsis in the business of deliverability, login rate limiting and — the killer — **building organizations, invitations and roles by hand** when agencies arrive. That is a lot of security-sensitive code to own for a product whose value is elsewhere. Rejected. |
| **Platform-native (Vercel)** | Vercel Authentication protects *deployments*, not application users. Not applicable — listed because it is worth ruling out explicitly. |
| **OAuth providers directly (Google/GitHub)** | Still needs session storage and a user record, and forces every future agency onto a consumer identity. Rejected. |
| **Supabase Auth** | Comes with a Postgres database. That is *more* than this milestone needs, and adopting a platform to get a login form is the definition of painting into a corner. Revisit if and when CRM data moves server-side. Rejected for now. |
| **Managed provider, hosted page, provider-sealed session in Apsis's cookie** | **Chosen.** No passwords, no user table, no browser SDK, no hand-written session crypto, and organizations/roles arrive for free when needed. One server-side dependency, justified in §C. |

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

### The dependency, and why it is the right call

**`@workos-inc/node`, pinned to `^10.13.0`, server-side only.**

An earlier draft of this contract had Apsis implement its own AES-256-GCM sealed
session containing the refresh token. **That was wrong, and it is withdrawn.**
Session cryptography — sealing, JWT validation against a rotating JWKS, refresh
rotation, replay grace — is precisely the category where a vetted provider
implementation beats custom code written once and reviewed by nobody. Being
dependency-averse is a good instinct that becomes a bad one exactly here.

Three facts make the dependency cheap rather than a compromise:

- **Zero runtime dependencies and zero peer dependencies** (verified against the
  registry at `10.13.0`). It drags in no supply chain.
- **`engines: node >=22.11.0`**, which matches the Node 22 runtime the endpoint
  already targets.
- **It is server-side only.** No WorkOS code, key, or token reaches the browser.

**This does not relax D27.** That invariant is about *model* integration and
*browser* credentials, both unchanged: Anthropic remains `fetch`-only with no
SDK, there is no browser auth SDK, and no WorkOS credential exists client-side.
The new rule is narrow and stated as its own invariant in §R.

---

## D. Session / token model

**The provider's sealed session, carried in a cookie Apsis owns.** Apsis writes
no session cryptography of its own.

All API names below were read from the published type definitions of
`@workos-inc/node@10.13.0`, not from prose. (Worth noting: the docs page renders
the logout helper as `getLogOutUrl`; the shipped types say **`getLogoutUrl`**.
The types win.)

```ts
// Seal at login — the SDK encrypts and returns the sealed string.
const auth = await workos.userManagement.authenticateWithCode({
  code,
  codeVerifier,                                   // PKCE
  session: { sealSession: true, cookiePassword },  // cookiePassword ≥ 32 chars
});
auth.sealedSession   // → Apsis's cookie value

// Open on every protected request. Synchronous; returns a CookieSession.
const session = workos.userManagement.loadSealedSession({
  sessionData: cookieValue,
  cookiePassword,
});

const result = await session.authenticate();
// success → { authenticated: true, sessionId, organizationId?, role?, roles?,
//             permissions?, entitlements?, featureFlags?, user, impersonator?,
//             accessToken, authenticationMethod }
// failure → { authenticated: false, reason: 'invalid_jwt'
//                                        | 'invalid_session_cookie'
//                                        | 'no_session_cookie_provided' }

const refreshed = await session.refresh({ cookiePassword, organizationId? });
// success → { authenticated: true, sealedSession?, session?, …same claims }
// failure → terminal or retryable — see §D.1

const url = await session.getLogoutUrl({ returnTo });
```

**What Apsis still owns, and this is the architectural point:** the cookie and
every one of its attributes, when authentication is required, how `Identity` is
derived, what capabilities exist, 401/403 semantics, and what the SPA is told.
The SDK supplies the sealed payload; Apsis decides everything around it. A
sealed session that fails to open is simply an unauthenticated request.

**What was removed from the design:** Apsis's own AES-256-GCM seal/open, its own
session payload format, its own refresh-token storage, and its own rotation
handling. `APSIS_SESSION_SECRET` becomes `WORKOS_COOKIE_PASSWORD` — the same
kind of secret, but consumed by the SDK rather than by code Apsis wrote.

### D.1 Refresh: rotation, replay grace, and failing safe

The earlier draft said concurrent refreshes make the loser's token fail and
force another refresh. **That was wrong too.** The SDK models the real
behaviour, and it distinguishes two failure classes in its own types:

```ts
type RefreshSessionTerminalFailedResponse  = { authenticated: false; reason; retryable: false };
type RefreshSessionRetryableFailedResponse = { authenticated: false; reason; retryable: true;
                                               retryAfter?: number; error?: unknown };
```

| class | reasons | meaning |
|---|---|---|
| **terminal** | `invalid_session_cookie`, `no_session_cookie_provided`, `invalid_grant`, `mfa_enrollment`, `sso_required` | the session is over; the user must sign in again |
| **retryable** | `rate_limit_exceeded`, `timeout`, `server_error`, `network_error` | the refresh token is **likely still valid**; keep the session and retry later |

**Binding fail-safe rule:** `retryable: true` must **never** sign a user out.
The existing session cookie is left exactly as it is, the request is answered —
and because refresh only runs when the access token has expired, the honest
options are to serve the request on the still-valid session if the SDK reports
it authenticated, or to return **503 with `Retry-After`** rather than 401. A
WorkOS outage or a 429 must not look like a logout to every signed-in user at
once. `retryAfter` is honoured when present.

Only `retryable: false` clears the cookie and yields 401.

**Concurrent refresh** is handled by WorkOS's refresh-token rotation with a
replay grace period: two tabs refreshing at once do not invalidate each other,
which is why no cross-tab coordination is needed and why Apsis must not build
a refresh mutex. On success the returned `sealedSession` **must** be written
back as the new cookie value — dropping it is how a rotated token gets lost.

**The revocation window, restated accurately.** `authenticate()` validates the
access JWT locally; WorkOS is only consulted at `refresh()`. So a stolen cookie
remains usable until the access token expires — a lifetime **configured in the
WorkOS dashboard**, not chosen by Apsis, and short by default. Clearing the
cookie logs out the browser holding it, not a copy someone else took. That is
proportionate while the protected resource is a metered API and no customer
records exist server-side; it stops being proportionate the moment CRM data
moves server-side, which is §I's trigger.

**Multi-tab:** the cookie is shared across tabs, so a refresh in one is
immediately effective in all.

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

**No token in `localStorage`, `sessionStorage`, or JS memory. Ever.** The cookie
value is the provider's sealed blob — opaque to the browser and useless without
`WORKOS_COOKIE_PASSWORD`, which exists only on the server. The only thing the
browser learns about the session is what `GET /api/session` chooses to tell it
(§Q). The browser never receives the WorkOS API key, an access token, a refresh
token, or the cookie password.

---

## F. Authentication flow

Every call below is a real `@workos-inc/node@10.13.0` API, read from its types.

```
GET /api/auth/login?returnTo=/
  const { url, state, codeVerifier } =
    await workos.userManagement.getAuthorizationUrlWithPKCE({ redirectUri, … })
  → seal `state` + `codeVerifier` into a short-lived HttpOnly
    `apsis_auth_challenge` cookie (10 min, SameSite=Lax)
  → 302 to `url`

GET /api/auth/callback?code=…&state=…
  → open the challenge cookie; require `state` to match; clear it immediately
  → const auth = await workos.userManagement.authenticateWithCode({
        code, codeVerifier,
        session: { sealSession: true, cookiePassword: WORKOS_COOKIE_PASSWORD },
      })
  → write `auth.sealedSession` as a NEW `apsis_session` cookie (fixation defence)
  → 302 to the validated `returnTo`

POST /api/auth/logout
  → const session = workos.userManagement.loadSealedSession({ sessionData, cookiePassword })
  → const url = await session.getLogoutUrl({ returnTo: '/' })   // note the casing
  → clear `apsis_session` with Max-Age=0, then 302 to `url` so the
    provider-side session ends too
  → clearing the cookie WITHOUT the provider redirect would leave the session
    alive at WorkOS; both halves are required

GET /api/session
  → `{ authenticated: false }` or
    `{ authenticated: true, userId, organizationId, capabilities }`
```

- **PKCE and `state` come from the SDK** (`getAuthorizationUrlWithPKCE` returns
  `{ url, state, codeVerifier }`), so neither is hand-generated. `state` is the
  CSRF defence for the redirect; PKCE means an intercepted `code` is useless
  without the verifier.
- **`returnTo` is allowlisted:** must begin with a single `/`, must not begin
  with `//` or `/\`, must not contain a scheme. Anything else becomes `/`. This
  is the open-redirect defence and it is not optional — it applies to the login
  `returnTo` *and* to the value handed to `getLogoutUrl`.
- **No account enumeration:** Apsis has no endpoint that takes an email. The
  provider's hosted page owns that surface.
- `WORKOS_COOKIE_PASSWORD` must be **at least 32 characters**; the SDK rejects
  shorter ones.

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
  | { status: 'anonymous' }                                   // → 401
  | { status: 'expired' }                                     // → 401, clear cookie
  | { status: 'transient'; retryAfter?: number }              // → 503, KEEP cookie (§D.1)
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
| **401** | no session, expired, malformed, or terminally refused | `{"error":"unauthenticated"}` |
| **403** | valid session without the capability | `{"error":"forbidden"}` |
| **503** | refresh failed **transiently** — session kept, not a logout (§D.1) | `{"error":"auth_unavailable"}` + `Retry-After` |

The 503 is the fail-safe that stops a WorkOS outage or a 429 from reading as a
mass logout. The client treats it exactly like every other non-2xx: fall back to
the grammar with a note, and leave the session alone.

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

- **new** `server/auth/provider.ts` — the `AuthProvider` seam + the WorkOS
  adapter. **The only file permitted to import `@workos-inc/node`** (besides its
  own tests).
- **new** `server/auth/capabilities.ts` — `capabilitiesFor`, `can`. No WorkOS import.
- **new** `server/auth/identity.ts` — the `Identity` type and `AuthResult`. No WorkOS import.
- **new** `server/auth/*.test.ts`
- `server/interpret.ts` — inject `authenticate`, the order in §J. **Must depend
  only on the generic seam**, never on WorkOS types.
- `server/guard.ts` — limiter keying only; transport guards unchanged
- **new** `api/auth/login.ts`, `api/auth/callback.ts`, `api/auth/logout.ts`,
  `api/session.ts` — thin adapters, same rule as `api/interpret.ts`
- `scripts/dev-interpreter.mjs`, **new** `scripts/devIdentity.mjs`
- `src/command/interpreter.ts`, `src/command/router.ts` — 401/503 notes only
- `src/ui/CommandBar.tsx` — the sign-in affordance only
- `vercel.json` — `supportsCancellation` for the new functions
- `package.json` — **`@workos-inc/node` only**
- `.env.example`, README, `docs/**`, new test files

### The dependency rule (binding)

1. `@workos-inc/node`, pinned `^10.13.0`, **server-side, authentication only**.
2. **No WorkOS browser SDK**, and no WorkOS credential, token or cookie password
   in the browser.
3. **No LLM SDK** — Anthropic stays `fetch`-only. D27 is unchanged.
4. WorkOS may be imported by `server/auth/provider.ts` and its tests **and
   nowhere else**. Not by `server/interpret.ts`, not by `api/**`, not by
   `src/**`, not by domain code.
5. `/api/interpret` depends only on the generic `authenticate` / `Identity`
   seam, so swapping providers touches one file.

A test enforces rules 2 and 4 by scanning imports, because a boundary nobody
checks is a boundary that moves.

## S. Files forbidden to change

`src/domain/**` (`query.ts` is still the oracle) · `src/state/**` ·
`src/universe/**` · `src/orchestrator/**` · `src/ui/**` except `CommandBar.tsx` ·
`src/command/parseInterpretation.ts` · `server/provider.ts` and
`server/prompt.ts` (the model path is unrelated to auth) ·
`e2e/llm-command.spec.ts` · `e2e/reachability.spec.ts` ·
`e2e/host-boundary.spec.ts` · `e2e/progressive-reveal.spec.ts` ·
`e2e/spatial-focus.spec.ts` · `e2e/persistence.spec.ts` · `.github/**` beyond a
job needing no secret.

**No runtime dependency other than `@workos-inc/node`.**

---

## T. Unit tests

Every test uses a **fake `AuthProvider`** except the adapter tests, which use a
fake WorkOS client. **CI never needs a WorkOS account or credential.**

1. **Unauthenticated never reaches the provider** — a fake model provider
   asserts zero calls across every unauthenticated shape.
2. Valid session → 200 through `/api/interpret`.
3. Expired session → 401, and the cookie is cleared.
4. Malformed session → 401 for each SDK reason: `invalid_jwt`,
   `invalid_session_cookie`, `no_session_cookie_provided`.
5. **Terminal refresh → 401.** Each of `invalid_grant`, `mfa_enrollment`,
   `sso_required`, `invalid_session_cookie`, `no_session_cookie_provided`
   clears the cookie and de-authenticates.
6. **Transient refresh → session survives.** Each of `rate_limit_exceeded`,
   `timeout`, `server_error`, `network_error` returns 503 with `Retry-After`,
   **leaves the cookie untouched**, and does NOT sign the user out. This is the
   regression test for "a WorkOS blip logs everyone out".
7. **Rotation is persisted** — a successful `refresh()` returning a new
   `sealedSession` writes it back as the cookie; dropping it is a bug the test
   catches.
8. **Concurrent refresh** — two overlapping refreshes on the same session both
   resolve without either being de-authenticated, matching WorkOS's replay
   grace; and Apsis adds no refresh mutex.
9. **Adapter mapping** — a WorkOS success response maps to canonical `Identity`:
   `sessionId` from `sessionId`, `organizationId` from `organizationId ?? null`,
   `capabilities` from `capabilitiesFor(role/roles/permissions)`. **`user`,
   email and profile fields are dropped**, asserted field by field.
10. **Forged identity ignored** — `x-user-id`, `x-org-id`, `role` headers and
    body fields change nothing.
11. Authenticated without the capability → 403.
12. Logout clears the cookie with `Max-Age=0` **and** redirects to
    `getLogoutUrl()`; a subsequent protected call is 401.
13. **CSRF** — cross-site `Origin` is 403 before auth runs; `state` mismatch is
    rejected; a missing challenge cookie is rejected.
14. **Cookie attributes** — `HttpOnly`, `Secure` in production, `SameSite=Lax`,
    `Path=/`, no `Domain`; `Secure` omitted only for `http://localhost`.
15. **Browser never sees provider tokens** — no response body or non-session
    header ever contains an access token, refresh token, API key or the cookie
    password; `/api/session` returns only `authenticated`, `userId`,
    `organizationId`, `capabilities`.
16. **No secret in logs** — cookie value, sealed session, tokens, `code` and
    `state` absent from every `LogEntry`; email absent because it is never stored.
17. **Per-user isolation** — two users behind one IP have independent buckets.
18. **IP backstop** — an unauthenticated flood from one IP is still limited.
19. **Auth failure consumes no provider tokens** — 401/403/503 paths assert zero
    model-provider calls.
20. `returnTo` allowlist — `//evil.test`, `/\evil.test`, `https://evil.test`
    and scheme-relative URLs all collapse to `/`, for login and logout.
21. Session fixation — the session after login differs from any pre-auth cookie,
    and the challenge cookie is cleared.
22. **Import boundary** — only `server/auth/provider.ts` (and its tests) imports
    `@workos-inc/node`; nothing under `src/`, `api/`, or the rest of `server/`
    does.
23. **No dev bypass in the production graph** — the import graph from
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
3. 401, 403 and 503 are distinct, and all 401 causes are indistinguishable to
   the caller.
4. **A transient refresh failure never signs anyone out** — `retryable: true`
   keeps the cookie and answers 503, asserted for all four reasons.
5. No token, sealed session, API key or cookie password is readable from
   JavaScript, returned to the browser, or present in any log.
6. Apsis writes no session cryptography; sealing, JWT validation and rotation
   are the SDK's. A rotated `sealedSession` is always persisted.
7. `@workos-inc/node` is imported by `server/auth/provider.ts` and its tests
   only — enforced by an import scan — and no browser auth SDK exists.
8. The IP backstop survives; per-user limiting is added, not substituted.
9. The default build still makes zero network requests and needs no credential.
10. CI passes with **no WorkOS account and no credential of any kind**.
11. The dev bypass is absent from the production import graph, proven by test.
12. `src/domain/**`, `src/state/**`, `src/universe/**` unchanged; the 320 unit /
    48 browser baselines hold and grow, never shrink.
13. D27 intact: Anthropic is still `fetch`-only with no LLM SDK.
14. Grammar fallback, validator authority, provider privacy boundary,
    cancellation, D32–D35, Round 7, §14, progressive reveal, persistence and
    replay all intact.

## W. Implementation sequence

1. `package.json` — add `@workos-inc/node` pinned `^10.13.0`. Confirm the lock
   file adds no transitive runtime dependency.
2. `server/auth/identity.ts` + `capabilities.ts` + tests — the canonical
   `Identity`, `AuthResult` (including `transient`), and `capabilitiesFor`.
   **No WorkOS import in either file**; this is the seam everything else uses.
3. `server/auth/provider.ts` — the WorkOS adapter: `getAuthorizationUrlWithPKCE`,
   `authenticateWithCode({ session: { sealSession: true, cookiePassword } })`,
   `loadSealedSession`, `authenticate()`, `refresh()`, `getLogoutUrl()`, the
   `returnTo` allowlist, and the **terminal vs retryable** mapping of §D.1.
   Tests with a fake WorkOS client — T.4–9 live here.
4. `server/interpret.ts` — inject `authenticate`, implement §J's order. T.1–2,
   10–11, 17–19 against fakes.
5. `api/auth/*` and `api/session.ts` adapters; `vercel.json` entries.
6. `scripts/devIdentity.mjs` + wiring; T.22–23.
7. Client: 401/503-aware notes, then the sign-in affordance.
8. Browser tests with mocked `/api/session`.
9. Full gates, then a real end-to-end login against a WorkOS **development**
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
> order — the canonical `Identity` and capability seam first, with no WorkOS
> import in them, before the adapter exists.
>
> Put an identity in front of `POST /api/interpret` using **WorkOS AuthKit via
> `@workos-inc/node@^10.13.0`, server-side only**. Use the SDK's own session
> primitives — `getAuthorizationUrlWithPKCE`, `authenticateWithCode` with
> `session: { sealSession: true, cookiePassword }`, `loadSealedSession`,
> `authenticate()`, `refresh()`, `getLogoutUrl()`. **Write no session
> cryptography.** The earlier hand-rolled AES-256-GCM design is withdrawn.
>
> **The requirement that defines the security posture (§H, D36):** identity is
> derived server-side from the sealed cookie. `userId`, `organizationId`, roles
> and capabilities sent by the browser are ignored, and a test asserts forged
> values change nothing. Drop `user`, email and profile — carry only
> `userId`, `sessionId`, `organizationId`, `capabilities`, `expiresAt`.
>
> **The requirement that defines the milestone (§J, D37):** the IP limiter runs
> before authentication and authentication runs *before the request body is
> read*, so an unauthenticated request can never reach the model provider. Prove
> it with a fake model provider asserting zero calls.
>
> **The requirement that stops an outage becoming a mass logout (§D.1):** a
> `retryable: true` refresh failure — `rate_limit_exceeded`, `timeout`,
> `server_error`, `network_error` — **keeps the session**, returns 503 with
> `Retry-After`, and never clears the cookie. Only `retryable: false` yields 401.
>
> **The boundary that must not move (§R):** `@workos-inc/node` may be imported
> by `server/auth/provider.ts` and its tests and nowhere else — not by
> `server/interpret.ts`, not by `api/**`, not by `src/**`. No browser auth SDK,
> no WorkOS credential in the browser, and Anthropic stays `fetch`-only. A test
> scans imports and enforces it.
>
> **The requirement that keeps the project workable (§O, §Q):** the dev identity
> lives outside `server/`, is imported only by `scripts/`, and is absent from the
> production bundle — asserted by an import-graph test. No `?auth=off`. v1 gates
> the **interpreter, not the application**, so the default build still needs no
> credential and still makes zero requests.
>
> Files allowed in §R, forbidden in §S. Meet every criterion in §V. Run
> TypeScript, lint, all unit/server tests, build, and the full browser suite;
> the 320 unit / 48 browser baselines must hold and grow. CI must pass with **no
> WorkOS credential**.
>
> Do not begin CRM integration, billing, or a user database.
