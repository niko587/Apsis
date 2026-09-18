# Next Actions

_Last updated: 2026-09-18 (Autopilot pre-live safety closeout).
Ordered. Each item: what, why now, acceptance, suggested model (spec §2)._

**Closed:**
- GitHub bootstrap. Remote exists, `main` canonical, `/docs` browsable (D19).
- **Browser reachability suite** — `e2e/reachability.spec.ts`, proven to catch
  D12 by reverting the rail (D20, re-proven under D35).
- **CI** — `.github/workflows/ci.yml`, five gates on push/PR, badge in README.
- **Performance investigation, rounds 1–7 — RESOLVED and accepted.** Full
  history, refuted hypotheses and diagnostic evidence preserved in
  `docs/PERFORMANCE_BASELINE.md`; do not prune it.

**CI trust restored (2026-09-15).** The reachability suite's over-strict
containment check is fixed (D21); it now asserts the click point rather than the
whole bounding box. No product or layout change was needed — the layout was
verified sound first.

**PERFORMANCE IS CLOSED.** The owner's final A/B on the real 2020 M1 MacBook
Air: dramatically smoother, visual difference tiny and still just as good, and
the original lag is gone. Round 7 (no live backdrop sampling + half-resolution
bloom) is the accepted shipping baseline — see `PERFORMANCE_BASELINE.md`
closeout. Performance is **no longer the top blocker**, and no further rendering
optimisation is warranted or wanted.

Arc A, Persistence v1, §15 drill dimensions, §14 spatial individual focus,
progressive lead reveal and **opt-in LLM command parsing** are all closed — §14
and progressive reveal owner accepted. LLM command parsing is **implemented**
(`src/command/`, contract `docs/CONTRACT_LLM_COMMAND_PARSING.md`) and is inert
by design: it does nothing until a host declares an endpoint, and Apsis
deliberately cannot supply one, because supplying one would mean holding the
key.

The **host interpreter endpoint** is implemented and deployment-hardened
(`server/`, `api/`, contract `docs/CONTRACT_HOST_INTERPRETER_ENDPOINT.md`,
D29–D34), and the one recorded browser flake is closed (D35). No live-provider
call has been made yet — see §1a.

**Authentication is implemented** (§1b) — `/api/interpret` now requires a
verified identity, and fails closed when unconfigured. Nothing else is open:
there are no known failing tests and no recorded intermittents.

Two verifications remain and **neither has been run**, because no credentials
exist in this environment: a real WorkOS development sign-in, and the Anthropic
live smoke test. Exact commands for both are in the README. Neither blocks the
current milestone.

**Autopilot v1 is built** (§1f) — `tools/autopilot/`, local developer tooling
that runs the GPT-plans / Claude-implements / controller-gates / owner-merges
loop. It has NOT been used on Apsis, and no live provider call has been made.
The next action there is the owner's: add a local OpenAI key and run one
supervised task.

**Dynamic drill dimensions are implemented and closed out** (§1e) — all nine registered
dimensions are reachable through a per-level picker, and a user who never opens
it walks the same path as before. **Nothing is open.** The only remaining
milestone-independent work is the two live verifications above and the optional
hygiene item in §3.

## 0. (closed) Reachability suite over-strictness — FIXED, CI trust restored
The assertion required an element's whole bounding box inside the viewport,
which made the verdict depend on font metrics; it now asserts that the click
point is on screen and hit-tests to the target. Verified first that the layout
was sound (last panel fully inside the rail at max scroll at all three
viewports, 14px to spare) — **no product or layout change was made**. Still
catches D12: reverting `.rail` to `overflow: hidden` turns 6 of 8 red. See D21.

## 0b. (closed) Arc A — transport seam proven with a second source
`ReplaySource` ships alongside the simulator behind an explicit `LeadSource`
contract; `?source=replay` plays a deterministic fixture through the same
`ingest`. 22 tests added (88 → 110) covering format validation, ordering,
timing, clean stop, determinism and a record → serialize → replay round trip.
Browser-verified: the booked centre advanced through the real pipeline with no
console errors. See `ARCHITECTURE.md` → "The source contract".

## 0c. (closed) Persistence v1 — sessions survive reload
Canonical event log in IndexedDB, replayed through `ingest` on boot behind a
singleton boot promise (restore → record → source). Two-step Reset control.
`?source=replay` isolated. 23 unit tests + 3 browser reload tests. Corruption
fails loudly and never partially applies. See `ARCHITECTURE.md` → "Persistence
v1" and D23.

## 0d. (closed) §15 drill dimensions — campaign, source, agent, timeframe
Eight registry dimensions; `DRILL_SEQUENCE` unchanged so the drill UI and camera
are untouched. New `Lead` fields hash the id rather than consuming the seed
stream, so persistence needed no migration (D24). 23 tests added (133 → 156).
Not in the default drill path — a dimension picker is UI work for later.

## 0e. (closed) §14 spatial individual transition — **OWNER ACCEPTED**
Camera completes the approach (was a 45% lean), a stage-coloured reticle
resolves the lead, a tracking glass card confirms it in-scene; rail untouched,
Escape order unchanged, +1 draw call, reduced-motion and a11y contracts held.
Implemented by Fable; **accepted by the owner on the real 2020 M1 MacBook Air.**

## 0f. (closed) Progressive lead reveal through drill depth — **OWNER ACCEPTED**
`LeadList` now reads the drill path and filters through `matchesPath` before the
cap, composing with command results and then search; the header states what it
is showing ("N in cluster" / "showing X of Y" / "N of M match" /
"· command filtered") rather than implying completeness. Hover is bidirectional
(one extra draw call, `FrontSide` billboard). Verified on the full 4,892-lead
book: Colorado 98 → Colorado Springs 24 → Supplemental 4, with the target lead
listed first. Contract: `docs/CONTRACT_PROGRESSIVE_REVEAL.md`.

**The lesson it added (again):** nine specs passed while the roster sat 145–345px
below the rail's fold, and a later revision left rows whose click point was off
screen — a synthetic `.click()` still "worked". The suite now asserts the row's
click point is on screen, hit-tests to the row, and that a real click selects.
Same family as D12: **visible must mean operable.**

## 1. (closed) LLM command parsing (opt-in) — IMPLEMENTED, owner verification pending
**MODEL: OPUS.** Contract: **`docs/CONTRACT_LLM_COMMAND_PARSING.md`**, met in
full. Implementation in `src/command/` (three files: `parseInterpretation.ts`,
`interpreter.ts`, `router.ts`), one `await` in `CommandBar.tsx`, one additive CSS
rule. `src/domain/query.ts` is byte-unchanged and no dependency was added.

**Activation.** `window.__APSIS_COMMAND_INTERPRETER__ = { endpoint, timeoutMs? }`,
declared by the host exactly as `__APSIS_MODEL_ENV__` is. Absent, malformed or
empty ⇒ no interpreter exists. `?interpreter=off` forces the grammar.

**What ships by default:** nothing changes. With no declaration, `resolveCommand`
returns the grammar's answer *synchronously* — no promise, no microtask, no
timer, no request — proven by a 22-command corpus deep-equal against
`parseCommand`, a `fetch` stub that throws if touched, and a browser test that
records every request the page makes.

**Honesty.** Every filter must cite a span present verbatim in the input, the
action included (D28); `unrecognised` is computed by subtracting accepted spans,
never taken from the model. The model's `unmapped` is validated and not
rendered.

**Security.** No credential, no vendor call, no SDK (D27). The request body is
`{ text, schema }` and nothing else.

**Still to do:** owner verification on the real machine, and a host endpoint —
see §1a, which is now the current milestone.

## 1a. (closed) Host interpreter endpoint — IMPLEMENTED, owner verification pending
**MODEL: OPUS.** Contract written and committed:
**`docs/CONTRACT_HOST_INTERPRETER_ENDPOINT.md`** — runtime choice, directory
layout, endpoint contract, provider interface, model recommendation, secret
handling, structured output, validation in both directions, privacy and logging,
rate limiting, timeout ladder, local development, deployment, file boundaries,
15 tests, acceptance criteria, sequence, and the implementation prompt in §S.

**What:** Apsis's first server-side code — `POST /api/interpret`, same origin,
Node 22, a plain `Request → Response` handler with a three-line platform
adapter. Anthropic via `fetch` with forced tool use; **no SDK, no new
dependency**, so D27 stands unamended. Default model
`claude-haiku-4-5-20251001`; `APSIS_MODEL` switches it.

**The three decisions that shape it:**
1. **Same origin.** Removes CORS, preflight, a second hostname and any browser
   credential, and makes the client's existing `endpoint: '/api/interpret'` work
   verbatim.
2. **The client's `schema` is ignored.** The server builds its prompt from its
   own pinned copy of `COMMAND_SCHEMA`, imported from the client module so the
   two cannot drift. A client-supplied vocabulary must never reach the model —
   that is the schema-injection answer.
3. **The endpoint is not trusted.** Forced tool use narrows the output; the
   browser validator still governs what reaches `LeadQuery`. The blast radius of
   a bad or injected model answer is set by the validator, not the prompt.

**Acceptance headline:** `src/**` unchanged, the full suite green **without a
key**, and the default build still making zero network requests —
`e2e/llm-command.spec.ts` must pass unmodified, which is what proves the client
does not care whether this endpoint exists.

**Delivered** in `server/` (prompt, guard, provider, interpret + 3 test files),
`api/interpret.ts`, `scripts/dev-interpreter.mjs`, `public/apsis-config.js`,
`tsconfig.server.json`, one `<script>` in `index.html`, a `/api` dev proxy and a
`dev:api` script. **No new dependency; `src/**` unchanged.** D29–D31.

**Stated plainly, not buried:** the endpoint is unauthenticated and backed by a
metered vendor key, so anyone who can reach it can spend it. Rate limiting,
size caps, same-origin checks and a vendor spend cap are cost control, not
access control. The README says so.

**Deployment hardening (D32–D34)** closed three review findings, each of which
would only have failed in production: `temperature: 0` made
`APSIS_MODEL=claude-sonnet-5` a hard 400 (no sampling parameters are sent now,
on any model); Vercel request cancellation is opt-in per path and is now enabled
in `vercel.json`, without which abandoned requests keep running and are billed;
and the rate-limiter cleanup ran after the push, so it could never fire and the
identity table leaked.

**No real-key call has been made.** Model ids, the forced `tool_choice` shape
and the Sonnet 5 sampling restriction were each confirmed against
platform.claude.com during the hardening pass, but every test still runs against
a fake provider. **The first thing to do with a key in hand is the smoke test in
the README** — `npm run dev:api` + `npm run dev`, then one `curl` at
`/api/interpret`.

## 1b. (closed) Authentication and access control — IMPLEMENTED, live verification pending
**MODEL: OPUS.** Contract written and committed:
**`docs/CONTRACT_AUTHENTICATION.md`** — threat model, provider choice, session
model, cookie attributes, flow, authorization seam, identity shape, tenant seam,
middleware order, 401/403 semantics, CSRF, rate limiting after identity,
logging, local development, CI identity, client UX, file boundaries, 18 unit +
7 browser tests, acceptance criteria, sequence, and the implementation prompt
in §Y.

The endpoint works and is deliberately not safe to expose: until identity exists
at the boundary, a public URL is a metered resource left unlocked.

**The recommendation, and why it is not the popular answer.** A managed provider
(WorkOS AuthKit) with a **hosted sign-in page**, a server-to-server code
exchange, and the provider's **sealed session carried in a cookie Apsis owns**.
No browser SDK, no password handling, **no Apsis database**. The deciding
criterion was not DX — it was what happens when agencies arrive: every
self-hosted path means building organization membership, invitations and roles
by hand, and a database, at exactly the moment the product is trying to sell.
The provider's session already carries `sessionId`, `organizationId`, `role`,
`roles` and `permissions`, so teams are a configuration change behind one seam.

**Security revision (D39/D40), applied before implementation.** The first draft
had Apsis hand-roll an AES-256-GCM sealed session containing the refresh token.
**Withdrawn.** Session sealing, JWT validation against a rotating JWKS, refresh
rotation and replay grace are exactly where a vetted provider implementation
beats custom crypto — so the design now uses `@workos-inc/node@^10.13.0`
server-side (`getAuthorizationUrlWithPKCE`, `authenticateWithCode` with
`session: { sealSession: true, cookiePassword }`, `loadSealedSession`,
`authenticate()`, `refresh()`, `getLogoutUrl()`). The SDK has **zero runtime and
zero peer dependencies**. **D27 is unchanged**: Anthropic stays `fetch`-only,
there is no browser auth SDK, and WorkOS may be imported by
`server/auth/provider.ts` alone — enforced by an import scan.

The same revision corrected the refresh semantics. WorkOS rotates refresh tokens
with a **replay grace period**, so concurrent refreshes do not invalidate each
other and Apsis must not build a mutex. And the SDK separates **terminal**
failures (`invalid_grant`, `mfa_enrollment`, `sso_required`, …) from
**retryable** ones (`rate_limit_exceeded`, `timeout`, `server_error`,
`network_error`). **A retryable failure must never sign a user out** — the
cookie is kept and the request answers 503 with `Retry-After`, because treating
a WorkOS blip as "your session ended" would convert an availability incident
into logging out every signed-in user at once.

**Three decisions worth arguing with:**
1. **Identity is derived, never received (D36).** Only the sealed cookie decides
   who you are; forged headers are ignored, and a test proves it.
2. **Authenticate before reading the body (D37).** An unauthenticated request is
   refused before its payload arrives, which makes "never reaches the provider"
   structural. The IP limiter stays *in front of* auth as the pre-identity
   shield; per-user limiting is added on top, not substituted.
3. **The dev bypass is absent, not disabled (D38).** It lives outside `server/`,
   is imported only by `scripts/`, and is therefore not in the production
   bundle. No `?auth=off`, no environment flag — an import-graph test asserts it.

**v1 gates the interpreter, not the application.** Gating the whole app would
protect nothing that needs protecting today and would break the "no credential
needed to work on Apsis" promise. **The trigger for changing that is explicit:
the moment any real customer data is served from the server, the app-wide gate
becomes mandatory.**

**Two honest limitations, recorded now rather than discovered later:** a stolen
cookie stays usable until the provider-configured access-token lifetime lapses,
because `authenticate()` validates locally and WorkOS is only consulted at
`refresh()`; and rate limits remain per-instance cost control rather than
durable quotas. Those two are precisely the things that will justify a database
— and nothing else in this milestone does.

**Correctness closeout (D42–D45).** Review found six defects, five of which
would only have shown up under a provider incident or a cross-site attack:
logout mutated on GET; `/api/session` discarded a rotated sealed session;
`/api/session` reported a transient failure as signed-out; any throw from
`authenticate()` meant expired; 401 and 403 shared one message; and the
challenge cookie was documented as sealed when it is not — now threat-modelled
and the contract amended rather than left mismatched. All closed, each with a
test that fails if it returns.

**Delivered.** `server/auth/{identity,capabilities,cookies,provider}.ts` plus
five test files, `api/auth/{login,callback,logout}.ts`, `api/session.ts`,
`scripts/devIdentity.mjs`, the §J pipeline order in `server/interpret.ts`, a
401/503-aware note in `src/command/{interpreter,router}.ts`, and a restrained
sign-in affordance in `CommandBar`. One dependency: `@workos-inc/node@10.13.0`,
imported by exactly one file, enforced by an import scan. Unit 421 (was 320),
browser 65 (was 48). D41 records what is structural; D42–D45 the closeout.

**The trigger, still explicit:** v1 gates the interpreter, not the application.
The moment real customer data is served from the server, the app-wide gate
becomes mandatory.

## 1e. (closed) Dynamic drill dimensions — IMPLEMENTED
**MODEL: OPUS.** Contract met in full:
**`docs/CONTRACT_DYNAMIC_DRILL_DIMENSIONS.md`** — mental model, interaction
choice, default behaviour, state, path semantics, availability rules, depth rule,
live-path validity, camera, field, roster, breadcrumbs, picker spec, responsive,
a11y, reduced motion, persistence, file boundaries, 17 unit + 15 browser tests,
performance acceptance, acceptance criteria, sequence and the prompt in §AA.

**The gap, now closed:** §15 registered nine dimensions — region, state, city,
segment, campaign, source, agent, timeframe, temperature. Four were reachable;
the other five were real, tested, and had no UI. All nine are reachable now.

**Delivered.** `clusters.ts` gained `MAX_DRILL_DEPTH`, `availableDimensions` and
`effectiveNextDimension`; `nextDimension(path)` was **removed** so no second
decision path exists. `drillStore` gained `nextDimensionId`/`chooseNextDimension`,
cleared by every navigation. `UniverseOverlay` turns the heading into the picker.
`CameraRig` and `SelectedLeadFocus` changed by one constant each.
**`LeadField.tsx` and `LeadList.tsx` are byte-unchanged** — the architectural
proof held. Unit 432 → 459, browser 66 → 81, no dependency added. D55–D57 record
what the implementation corrected about its own plan: the depth default is
positional; the 266-lead terminal is asserted against the pure seeded book while
the browser asserts shape, because the running app's decay drifts temperature
buckets; and field-position invariance is proven by a fixed clip of pure field
rather than a canvas screenshot, which would have included the overlay.

**Chosen interaction: choose the next grouping at each level (D48).** Presets
were rejected — a named library to maintain, a second concept before the user
asked for one, and a nearly-right preset still needs per-level control. What
makes per-level safe is that **the default chain is pre-selected at every
depth**: `DRILL_SEQUENCE` is demoted from "the drill order" to "the default
suggestion", which is the entire architectural change and the reason a user who
never opens the picker sees today's screen.

**Correctness revision (D52–D54), applied before implementation.** Review found
three claims that were wrong, and one that was only measured for the old fixed
sequence:

- **`agent` is not available on a fresh book.** Every seeded lead is
  `ownerAgentId: null`, so it has exactly one child — the earlier "all nine are
  available at GLOBAL" claim contradicted the availability rule itself. Rule
  kept, claim withdrawn (§F.1). No fake seed data and no special case.
- **A null selection cannot resolve straight to the depth default (D52).**
  `Agent → Timeframe → Segment` leaves a depth whose default `segment` is
  already used; `City` leaves a depth whose default `state` is already
  determined. `effectiveNextDimension` is now the single source of truth and may
  resolve *past* an unusable default — without touching `path`.
- **`availableDimensions` must traverse its iterable exactly once (D53).**
  Production passes `leads.values()`, a single-pass Map iterator, so a
  dimension-outer/lead-inner loop would report every dimension after the first
  as unavailable — a picker that only ever offers `region`, with nothing looking
  wrong in the code.
- **The 150-row cap was re-measured (D54).** Enumerating every reachable
  four-step path on the seeded book gives a **maximum terminal of 266**
  (`Northeast → New York → New York, NY → Cold`), 28 over 150. The old "never
  more than 81" guarantee is withdrawn. `LeadList.tsx` still stays forbidden,
  now on evidence: in-cluster search is applied *before* the cap, so every
  member is one keystroke away and the header already says
  `showing 150 of 266`.

**Three decisions worth arguing with:**
1. **One availability rule (D49).** A dimension is offered only if it splits the
   cluster into ≥2 children. That subsumes repeats *and* geography nesting —
   `region` after `state` yields one child, so no compatibility table is needed
   and none is added.
2. **`MAX_DRILL_DEPTH = 4` (D50).** Three files currently read
   `DRILL_SEQUENCE.length` to decide when §14 focus engages, silently coupling it
   to the default path's length. Depth-when-small was rejected: it would make
   `isIndividualFocus` depend on the book, and it is read *per frame*. **No test
   asserts the two are equal** — that would re-couple what the constant
   separates, letting a change to a convenience list redefine analytical depth.
3. **A live path is reported, never rewritten (D51).** Agent ownership,
   timeframe buckets and temperature all move under a standing path. No
   auto-popping, no substituted keys — an honest empty state and the existing way
   out. And nothing persists: a restored `timeframe · Today` is empty by morning.

**The architectural proof:** `LeadField.tsx` and `LeadList.tsx` must not change.
Emphasis, recession and the roster already derive from `matchesPath`, so a
dynamic path enters through the existing door. If either needs an edit, the
design is wrong.

## 1f. (closed) Autopilot v1 — BUILT, first supervised run pending
**MODEL: OPUS.** `tools/autopilot/` — a local CLI that automates what the owner
was doing by hand between a planning model and Claude Code. Docs:
`tools/autopilot/README.md` (setup and commands) and `AUTOPILOT_POLICY.md`
(scope, and the four facts no model verdict can override). Decisions D58–D61.

**The shape:** GPT-6 Astra plans one bounded task and later reviews the diff;
Claude Code implements it in a dedicated git worktree; **the controller runs the
gates itself** and compares the actual diff to the task's declared file surface;
up to three repair cycles; then it stops at `TASK READY FOR OWNER APPROVAL` and
prints the merge command. **It does not merge.**

**What makes it safe is structural, not prompted.** Gates are a closed enum that
only `gates.mjs` turns into literal argument arrays (`shell: false`), so an
arbitrary shell command is not a gate that fails but a value that cannot be
expressed. The boundary check runs before the gates and cannot be waived by a
reviewer. The git surface has no force push, no reset, no rebase, no branch
delete and no merge — absent, not guarded, the D38 argument. Secrets never enter
a prompt: the packet reads an allow-list, and `assertNoSecrets` aborts rather
than scrubbing, because scrubbing would conceal the bug that let a secret get
that far.

**No dependency was added** (D60). The OpenAI client, dotenv loader,
JSON-schema validator, argument parser and process runner are Node 22 built-ins
plus a few hundred lines — a deliberate trade, because this tool holds an API
key.

**Pre-live safety closeout (D62–D67).** Six gaps found by independent review,
all fixed: neither the worker nor any gate inherits the owner's credentials; the
worker's tool surface is pinned and has **no Bash**; `assertNoSecrets` now runs
on raw text so it can actually fire; new files are inlined in full for review and
unreviewable ones escalate; the boundary is checked three times because gates run
code; and a real run requires an explicit spend ceiling. The docs now state
plainly that v1 is **supervised**, not sandboxed.

**203 tests, all with fakes**: no OpenAI credential, no Anthropic credential, no
network, no live Claude invocation — and they run in CI, before the browser
stage. A test suite that costs money is one that stops being run.

**Still to do — and it is the owner's step, not a code step:**
1. `export OPENAI_API_KEY=...` and `export APSIS_AUTOPILOT_WORKER_BUDGET_USD=...`
   locally (never in the repo, never in a chat). The budget has no default and a
   real run refuses to start without it.
2. `npm run autopilot -- doctor --check-openai`
3. `npm run autopilot -- plan --goal "finish prototype polish"` — read the spec.
4. `npm run autopilot -- dry-run --goal "..."` — read what it would do.
5. One supervised `run`. Watch it. The first run is for deciding whether you
   agree with how it behaves, not for getting work done.

## 1d. Other candidates (none started)
- **Live verification.** A real WorkOS development sign-in, the Anthropic smoke
  test, and Autopilot's first supervised run. All three need credentials this
  environment does not have.
- **Durable quotas and instant revocation.** The two things that justify a
  database, and the two limitations above. Neither is urgent while the only
  protected resource is a metered API.
- **Organization/tenant model.** `organizationId` is carried and unused; the
  seam is ready when agencies are.

## 1c. (closed) Reachability wheel-stall flake — FIXED (D35)
`e2e/reachability.spec.ts @1600x1000` failed once, then passed on repeats — the
shape of a race, not a standing red.

**Root cause, in the test rather than the product:** `wheelIntoView` treated
three consecutive no-movement wheel ticks as "cannot scroll farther". The rail
is a living document (the activity feed gains rows, appointments land), so the
helper could bank stalls while sitting at a momentary bottom, give up, and then
have the rail grow underneath it — leaving the last panel a few px below a fold
that scrolling could by then have reached (`top=1028` in a 1000px viewport,
`afterWheelTicks=3`).

**Fix:** stop counting stalls and ask what the count was a proxy for. A tick
that moves nothing means either (a) there is room to scroll and the wheel could
not use it — the D12 regression, now caught on the FIRST tick rather than the
third, so the check got *stricter* — or (b) we are at the end of travel, in
which case the only question is whether that bottom is final, answered by
waiting for `scrollHeight` to settle. Grew ⇒ keep wheeling. Held still ⇒
genuinely unreachable. The settle is a bounded predicate (three agreeing 50ms
samples, ~600ms ceiling, five per call), not a sleep.

**Proven both ways:** reverting `.rail` to `overflow: hidden` turns 7 of 11 red
across all three viewports in 31s; `src/App.css` restored byte-identical. The
previously flaky viewport then ran **12 consecutive times clean** (36/36), and
the full browser suite is green. No assertion was weakened and no product code
changed.

## 2. (closed) The four red browser specs — triaged, and one was a real bug
Found at b96108d, fixed at the checkpoint below. They were **not** all stale, and
the most interesting one was not a test problem at all.

- **`spatial-focus.spec.ts:82` @2560×1440 — REAL PRODUCT DEFECT (D25).** The card
  never appeared because *nothing was ever selected*. `LeadDetail` grows from a
  79px placeholder to a ~389px record the moment it has a lead to show, and it
  sits above the Leads list — so the mouseenter on the way to a click pushed the
  target row ~310px down the rail and the click landed on bare rail. Present
  since the initial commit, live at every viewport for every human with a mouse;
  2560×1440 was simply the size where the rail had no scroll slack
  (`scrollHeight === clientHeight`) to absorb it. Fixed by scoping the detail
  panel's hover preview to `'field'` hovers. **No spec change was needed.**
- **`reachability.spec.ts:275` — flaky test (D26).** The roster re-sorts by score
  as events land, so `.first()` named a different lead at each of the three
  points the test used it. Now resolves the row to a lead id once and addresses
  that id.
- **`spatial-focus.spec.ts:128` — stale assumption.** `nth(1)` at `?leads=400`,
  where the drill-aware roster leaves exactly one row. Rewritten around the
  semantic target: focus now *retargets* within the cluster instead of
  dissolving, which is a stronger claim than the one it replaced.
- **`persistence.spec.ts:34` — flaky test, and a diagnostic that overstated.**
  It compared an in-memory event count taken before a reload against the restored
  count after it. Writes are throttled at 1.5s and `pagehide` cannot await a
  flush, so the tail was routinely not yet durable (observed: 48 of 50 came
  back). `PersistenceStatus` now reports `persisted` alongside `events` and the
  overlay prints both; the test waits for them to converge before reloading.

**Residual, recorded rather than fixed:** up to one write window (1.5s) of events
can still be lost if the page is closed abruptly. That is inherent to throttled
writes plus an un-awaitable `pagehide`, and the diagnostics line now tells the
truth about it instead of implying otherwise.

## 3. Hygiene — colour precompute / `positionInto` (NOT performance-justified)
**What:** precompute stage colours as RGB triples so no colour string is parsed
in a hot path, and add an out-parameter `positionInto(lead, out)` so the frame
path allocates nothing.
**Why it is LAST and must not be sold as a performance fix:** measured at
~16 ms per wall-clock second at the default book — invisible to a human — and
performance is closed. It remains real waste (`THREE.Color.setStyle` re-parses a
hex string per lead ~9×/s during the full-book revision walk; `positionFor`
allocates one object per lead) and would matter at 20k+ leads, but it is code
hygiene now.
**Acceptance:** no `Color.set(string)` or per-lead allocation on any per-frame
or per-event path; visual output unchanged; tests green. Any claim of
improvement must be measured, not assumed.
**Model:** Opus.

---

### Standing protocol reminder
After every meaningful phase: update `CURRENT_STATE.md` (+ this file), append
to `DECISIONS.md` if an invariant was added, sync `project-state.json`, and
commit docs together with the change they describe
(`AI_DEVELOPMENT_PROTOCOL.md`). The remote now exists — push to `main`.
