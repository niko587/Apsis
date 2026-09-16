# Current State

_Last updated: 2026-09-16 (authentication contract; previous phase: host
interpreter endpoint + deployment hardening)_

This file is the snapshot an external AI project manager should trust over any
conversation history. It describes the repository as it actually is.

## Health

| Check | Status | Command |
|---|---|---|
| TypeScript | clean (4 projects: app, node, e2e, server) | `npm run typecheck` |
| Unit tests | **320 / 320 passing** (19 files) | `npm test` |
| Browser suite | **48 / 48 passing** | `npm run test:e2e` |
| Lint | exit 0 (warnings only, see below) | `npm run lint` |
| Production build | green, ~1.27 MB bundle (350 KB gz) | `npm run build` |
| Runtime console | 0 errors at load and through drill/command flows | — |
| All five gates | the set CI runs | `npm run check` |

Run locally: `npm install && npm run dev` (port 5173) or
`npx vite preview --port 4173` after a build. URL params: `?leads=N` book
size, `?fx=off` disables post-processing. Playwright needs browsers once:
`npx playwright install chromium`.

**CI**: `.github/workflows/ci.yml` runs all five gates on push and PR to
`main`. Badge in `README.md`.

## What works end to end (all verified this session)

- 4,892-lead deterministic national book → scoring → gravity → 3D field;
  score is the only thing that moves a lead.
- Live simulated event feed (~9 events/s) driving stage changes, trails,
  telemetry, activity feed, appointments ledger.
- Agent system: task queue with per-lead claims, 7 agents, live arcs in the
  field, roster panel.
- Command bar: real grammar → understood-chips + ignored-words + funnel +
  field highlight + agent dispatch. Nationwide geography (cities, full state
  names, uppercase two-letter codes).
- Cluster drill (§15): GLOBAL → region → state → city → segment → individual,
  camera framing move, out-of-cluster leads dimmed not removed, breadcrumb +
  scrollable child chips, Esc backs out.
- Active Skills panel (§12) derived from live tasks/feed; expires by wall clock.
- Appointment centre (§16), lead detail (§14 content), telemetry (§17),
  accessibility (§21: listbox universe, keyboard camera, live regions, reduced
  motion), responsive (§22), WebGL-unavailable degradation boundary.
- Model Orchestrator (§30–40) in ASSISTED mode — honest about reachability,
  blocks rather than inventing a plan when no host descriptor exists.
- Raymarched Intelligence Core, freshly fixed (see below).

## Landed in the 2026-09-15 session

1. **Un-broke the build** — `drillStore.ts` had moved to `src/state/` with a
   stale `./clusters` import.
2. **Rail overflow fix** — the right rail was `overflow: hidden`; 5 of 9
   panels were unreachable and unclickable at 1600×1000. Now scrolls; every
   list owns a bounded band. Verified at 420–2560 px.
3. **Nationwide lead book** — `src/domain/geography.ts`: ~90 metros, 50
   states + DC, population-weighted sampling, metro-correct area codes.
4. **Region drill level** — drill is now region → state → city → segment;
   child chips scroll instead of truncating at 12.
5. **Parser geography** — nationwide city names (longest-first), full state
   names, uppercase-only two-letter codes (so "find **me** leads" is not a
   Maine filter). `LeadQuery` gained `states: string[]`.
6. **Core shader glitch fix** — three causes: fixed-offset march start
   (banding), noise frequency coupled to breathing radius (flicker under
   load), unbounded time (slow float32 drift). Now dithered, fixed-frequency,
   and phase-driven over a periodic lattice. Details in `DECISIONS.md` D15 and
   `src/universe/Core.tsx` comments.
7. Tests 80 → 88; docs (`README.md`, `SELF-CRITIQUE.md`) trued up.
8. **GitHub bootstrap** — remote created, SSH auth, unrelated histories
   merged, `main` pushed (see "Git / GitHub state" below and D19).

## Landed in the hardening phase (2026-09-15, later the same day)

Closes `NEXT_ACTIONS.md` items 2 and 3. No product code changed — the Lead
Universe, gravity, agents, command bar, drill, Core, telemetry, appointment
centre, a11y and responsive behaviour are all untouched.

1. **Browser reachability suite** (`e2e/reachability.spec.ts`, 8 tests).
   Nine rail panels plus the command bar at 1280×800, 1600×1000 and
   2560×1440: viewport geometry, `elementFromPoint` hit test, and a real
   click, reached only through genuine wheel events (D20). Plus an
   interaction test that clicks a lead row and asserts the selection lands in
   the detail panel — D12's sharpest symptom was an unclickable Leads list.
2. **Proved the suite catches D12.** Reverting `.rail` to `overflow: hidden`
   turns 6 of 8 red with the unreachable panels named; restored afterwards
   and confirmed byte-identical to the committed CSS.
3. **CI** (`.github/workflows/ci.yml`) — types · lint · unit · build ·
   reachability, on push/PR to `main`, with the Playwright report uploaded on
   failure. README badge added.
4. **Fixed a latent break introduced by adding `e2e/`**: vitest's default
   globs collect `**/*.spec.ts`, so `npx vitest run` would have tried to open
   a Playwright file. `vite.config.ts` now excludes `e2e/**` (D20).
5. **`package.json` gained the scripts the docs already assumed** — `test`,
   `typecheck`, `test:e2e`, `check`. README advertised `npm test` before it
   existed.

## Arc A milestone: the source seam is proven (2026-09-16)

**Apsis now has two concrete sources behind one contract**, which turns the
transport seam from a claim into a fact. `?source=replay` plays a deterministic
recorded session through the *same* `ingest` the simulator uses; everything
above the seam — scoring, gravity, state, agents, the rail, the Universe —
is unaware which one is running.

- **Contract made explicit** (`LeadSource { name, start, stop }`), simulator
  conformed to it, selection centralised in `src/state/sources.ts`.
- **`ReplaySource`** (`src/state/replay.ts`) — versioned format, validating
  parser that throws rather than dropping bad events, injectable scheduler so
  timing is testable without sleeping, single-timer chain so nothing can emit
  after `stop()`.
- **`createSessionRecorder`** captures the canonical stream by *observing* the
  store feed rather than wrapping `ingest` — it sees events from every route
  and adds nothing that can mutate state.
- **Built-in fixture** (`src/state/fixtures/demoSession.ts`): 14 real events,
  three parallel narratives — one lead all the way to booked, one going cold,
  one engaging without committing. Only genuine `LeadEventKind`s and real agent
  ids.
- **22 new tests** (88 → 110): format validation, order, relative timing, speed,
  no-emit-after-stop, truncation-is-a-prefix, twice-identical delivery,
  identical canonical state from the same seeded book, and a full
  record → serialize → parse → replay round trip.

Verified in a browser, no console errors: `/?source=replay` drove the booked
centre from 16 → **17**, meaning a lead reached periapsis through the real
pipeline — and only `appointment_booked` can cross `TOUCH_CEILING` (D3).

**`ingest` remains the only incoming-event mutation boundary.** Replay touches
no store field directly.

**Known limitation, by design:** replay does not reproduce the transient agent
*arcs* that were in flight during recording, because `AgentTask`s are
transport-side simulation rather than domain events. Replayed events still
carry their original `agentId`, so attribution survives; only the in-flight
animation does not. Decay is a no-op over any recordable session (72h grace).

## Persistence v1 (2026-09-16) — sessions survive a reload

**Apsis no longer resets when the browser refreshes.** The canonical event log
is written to IndexedDB and replayed through `ingest` on boot; the domain stays
authoritative and no second mutation mechanism exists.

- **Storage:** IndexedDB behind a `SessionStore` interface (`load`/`save`/
  `clear`/`available`), with an in-memory implementation for tests so the domain
  never imports a storage API. Chosen over localStorage because ~9 events/sec is
  several MB an hour and localStorage is synchronous on the main thread.
- **Boot order:** `bootSession()` is a singleton promise — restore fully, then
  record, then start a source. This prevents live events interleaving with
  restored history, and stops React StrictMode's double-invoked effects from
  hydrating the log twice.
- **Writes:** trailing *throttle* (1.5s), chained never concurrent, flushed on
  `pagehide`.
- **Reset:** a two-step "Reset session → Confirm reset" button in the existing
  topbar language; clears storage and reloads to the seeded book.
- **Replay isolation:** `?source=replay` neither reads nor writes the persisted
  session, so the demo fixture cannot overwrite a real book.
- **23 unit tests + 3 browser reload tests** (110 → 133 unit).

**Corruption policy — fail loudly, never plausibly.** Unknown version, malformed
record or any invalid event ⇒ discard, clear the slot, start fresh, report. Book
mismatch (`?leads=N` changed) ⇒ do not apply, *keep* the log, start fresh.
Storage unavailable or a write throwing ⇒ the app keeps running with durability
off and says so in diagnostics. Nothing is ever partially applied.

**Restored:** scores, stages, positions, the appointment ledger, booked count,
feed history, agent attribution, telemetry. **Not restored by design:**
in-flight agent arcs (transport-side simulation, not domain events), camera,
drill path, selection, command state.

**Two bugs found by testing rather than by reading**, both worth recording:
the diagnostics status was a snapshot captured at boot, so it reported "0
events" forever; and the write scheduler was a trailing *debounce*, which under
a continuous ~9/sec feed was cancelled and rescheduled before it could ever
fire — **nothing was persisted at all, with no error to show for it**. The
browser reload test caught both; the unit suite was entirely happy.

## §15 drill dimensions complete (2026-09-16)

The registry now carries **eight** dimensions: region, state, city, segment,
**campaign**, **source**, **agent**, **timeframe**, plus temperature. Each is a
`ClusterDimension` entry — there is no UI switch statement to update, and
`DRILL_SEQUENCE` (region → state → city → segment) is unchanged, so the default
drill path and camera behaviour are exactly as before.

- **`campaign` and `acquisitionSource` are new canonical `Lead` fields**, derived
  from `stableHash(id + salt)` rather than the seeded RNG stream. That is what
  makes them free: no pre-existing seeded value changed, so **Persistence v1
  needs no migration and no version bump**, and the Arc A replay fixture is
  unaffected (D24). A pinned-score test guards the property.
- Measured on the default book: campaign 26.5/20.7/16.4/13.9/12.2/10.3 %,
  source 26.5/21.7/19.2/14.7/11.0/6.9 % — weighted, nothing dominating,
  nothing vanishing. Every dimension's child counts sum to exactly 4,892.
- **agent** reads `lead.ownerAgentId` (real event attribution). On a cold book
  that is one honest **Unassigned** cluster; it splits as a session warms the
  book. Fabricating seeded ownership was rejected as inventing data.
- **timeframe** buckets `lastEventAt` — Today / 3d / 7d / 30d / Older — via
  `createTimeframeDimension(now)`, because `keyFor` takes no clock and a bucket
  assertion must not depend on when the suite runs.
- **23 tests added** (133 → 156). Parser grammar deliberately unchanged.

**Known limitation, stated rather than implied:** the four new dimensions are
registry-complete but not in `DRILL_SEQUENCE`, so they are not reachable from
the current linear drill UI — the same position `temperature` has always been
in. Exposing a dimension picker is UI work, not this milestone.

## §14 spatial individual transition complete (2026-09-16)

**The drill journey now ends somewhere.** At full drill depth, selecting a lead
resolves it spatially: the camera completes its approach onto the lead's live
rendered position (the old rig leaned 45% and stopped), a single shader-drawn
reticle rings the lead in its own stage colour — two fine rings, three slowly
orbiting arc segments, a soft halo, all riding the same bloom the sprites do —
and a compact glass card tracks it in screen space with name, stage, score,
segment · location and the next best action. The rail keeps every detail;
Escape unwinds focus first, then the drill, exactly as before.

Implementation is the contract's shape (`docs/CONTRACT_14_SPATIAL_INDIVIDUAL.md`):
- **No new state.** Focus = selection ∧ full depth ∧ cluster membership
  (`isIndividualFocus`, shared by reticle, card, camera and the tier-1 marker,
  which stands down while the reticle has the subject).
- **Two tiers preserved** — selecting from the list at GLOBAL still never
  flies the camera.
- A lead whose score carries it out of the drilled cluster mid-focus dissolves
  focus to the cluster framing rather than being chased.
- **+1 draw call at focus** (measured 30 → 31; budget was +2). Zero per-frame
  allocation; one DOM transform write per frame; card measurements throttled
  to every 20th frame.
- Reduced motion: camera still arrives (rate 24), orbits and pulse freeze,
  card appears without animation. Card is `aria-hidden`; SelectionAnnouncer
  remains the single announcer (asserted).
- New: `src/universe/SelectedLeadFocus.tsx`; camera leg in `CameraRig`
  (`INDIVIDUAL_DIST = APOAPSIS·0.44`, slight phi lift, settling re-armed on
  focus enter/leave/retarget); 9 unit tests + 7-case browser spec
  (`e2e/spatial-focus.spec.ts`) driving the deterministic
  West → Colorado → Colorado Springs → Supplemental → Claire Moreau journey.

## In flight right now

Nothing mid-edit. The working tree is consistent and all checks are green.
The next planned work is in `NEXT_ACTIONS.md`.

## Git / GitHub state

**Canonical remote: https://github.com/niko587/Apsis — `main` is pushed and
tracking.** Bootstrapped 2026-09-15; `NEXT_ACTIONS.md` item 1 is closed.

- The repo had **no version control at all** until 2026-09-15 — macOS ships
  `/usr/bin/git` only as a shim demanding the Xcode CLT, and the CLT install
  fails on this machine ("not currently available from the Software Update
  server"). The working git is a **standalone `dugite` build** behind a shim
  at `~/.npm-global/bin/git` (`git 2.53.0`, real binary under
  `~/.local/gittools/node_modules/dugite/git`). There is still no system git
  and no `gh` CLI.
- **Auth is SSH, not HTTPS.** The remote is `git@github.com:niko587/Apsis.git`.
  An ed25519 key sits at `~/.ssh/id_ed25519` (no passphrase, so pushes are
  unattended); `github.com` is pinned in `~/.ssh/known_hosts` with the
  verified fingerprint `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`.
  SSH was chosen over a token because dugite ships **no CA bundle** — its own
  shim comments note HTTPS pushing is untested — and because no credential
  helper (`osxkeychain`) exists in that build. Do not switch the remote back
  to HTTPS without solving the trust store first.
- The GitHub repo was **not empty**: it carried 3 stub commits (`Initial
  commit` plus two typo fixes, *Aspris* → *Apris* → *Apsis*) whose only
  content was a one-line `README.md`. Histories were **merged** with
  `--allow-unrelated-histories` rather than force-pushed, resolving the
  README add/add conflict in favour of the repo's real one. See D19.
- Git identity is set **repo-locally** (`niko <niko@nshealthsolutions.org>`),
  matching the pre-existing isomorphic-git commit. There is no global
  identity on this machine.

## Performance — RESOLVED (2026-09-15) — see `PERFORMANCE_BASELINE.md`

**Apsis is smooth on the owner's real 2020 M1 MacBook Air.** After a seven-round
investigation the owner's final A/B verdict on the shipping build versus
`?legacyfx=1`: performance **dramatically smoother**, visual difference **tiny
and still looks just as good**, remaining lag **none — the original problem is
basically solved**. Round 7 is accepted as the shipping performance baseline,
and performance is **no longer the project's top blocker**.

**Preserve this rendering/compositing architecture.** Two changes did it:

1. **No live backdrop sampling anywhere in shipping CSS.** All four
   `backdrop-filter: blur()` layers over the WebGL canvas are gone; the glass
   look is a gradient plus an inset rim highlight and a drop shadow, at an alpha
   matched to the blurred original's *perceived* density. **Do not reintroduce
   `backdrop-filter` over the canvas** — that was the bottleneck.
2. **Bloom renders at half resolution** (`resolutionScale={0.5}`), upsampled
   through the existing mip chain. The scene still renders at full DPR 2.

Intact and not to be traded away: the 4,892-lead book, Lead Gravity, scoring,
agents, trails, the raymarched Intelligence Core, bloom, transparency, DPR 2,
responsive behaviour, the dark cinematic identity.

Worth remembering for the next investigation: **the cause was in the compositing
stage, which no JavaScript instrument can observe.** Frame intervals looked
healthy in every round; every subtractive scene toggle came back unchanged
(a backdrop blur costs the same regardless of what is behind it); and the round-6
matrix on real hardware reported no configuration in distress. What located it
was reading the CSS, and the owner's subjective A/B — a human judgment that
outranked a clean-looking sample and was right. `?legacyfx=1` is preserved as
the reference control.

## Known issues and unverified claims

- **Performance is unverified on real hardware.** README's 60 FPS table
  (4,892/20k/60k leads) did not reproduce in the sandboxed environment, but
  the environment itself was proven fill-rate-bound (a trivial WebGL triangle
  page ≈ 4 FPS), so the numbers are *unverified*, not disproven. CPU side is
  provably light: with WebGL disabled the app holds ~59.6 FPS. Needs a
  real-GPU pass.
- **Core animation smoothness on real GPU** — the fix is structurally sound
  and renders correctly, but motion-at-speed was only assessable by the human.
  Awaiting user confirmation.
- `oxlint` emits ~20 warnings in `src/universe/LeadField.tsx` (refs during
  render / hook-argument mutation). These are R3F frame-loop idioms, not bugs;
  they are the accepted cost of a zero-allocation render path.
- First drill level is population-imbalanced by design (South 1,695 vs
  Midwest 924) — that is the real shape of the data, not a bug.

## What is real vs simulated

**Real** (exercised by the UI, covered by tests): domain model, scoring,
decay, gravity, event pipeline, store, telemetry, agents/tasks/claims,
appointments, query engine, drill model, orchestrator routing logic, all
rendering.

**Simulated**: `src/state/source.ts` — the event source. It fabricates
plausible stage-aware `LeadEvent`s at ~9/s. It is the single seam where a real
CRM/dialer/webhook transport plugs in; nothing downstream knows the difference.

**Real since this paragraph was last written**: persistence (a canonical event
log in IndexedDB, replayed through `ingest` on boot — reload no longer reseeds,
D23) and **opt-in LLM command parsing** (`src/command/`, D27/D28).

**Absent**: any backend. The LLM interpreter is implemented but **inert** — it
does nothing until a host declares `window.__APSIS_COMMAND_INTERPRETER__`, and
Apsis deliberately cannot supply one, because supplying one would mean shipping
a credential to the browser. Building that endpoint is the current milestone
(`docs/CONTRACT_HOST_INTERPRETER_ENDPOINT.md`). Also absent: programmatic
multi-model invocation (the environment provides no mechanism; the orchestrator
correctly reports ASSISTED) and any authentication.

## Host interpreter endpoint (2026-09-16) — Apsis's first server-side code

Apsis's first server-side code. `POST /api/interpret`, same origin, Node 22, a
plain `Request → Response` handler in `server/` with a three-line platform
adapter in `api/`. Anthropic via `fetch` with forced tool use — no SDK and no
new dependency, so D27's "no LLM SDK in package.json" stands unamended. Default
model `claude-haiku-4-5-20251001`, switchable by one environment variable.

The design is shaped by the client being finished and indifferent: the endpoint
is **not a trusted component**. Forced tool use narrows the model's output, but
the browser validator still governs what reaches `LeadQuery`, and if the
endpoint vanishes the product keeps working. `e2e/llm-command.spec.ts` must pass
unmodified — that is the proof.

**Delivered:** `server/{prompt,guard,provider,interpret}.ts` plus three test
files, `api/interpret.ts` (a three-line adapter), `scripts/dev-interpreter.mjs`,
`public/apsis-config.js` (inert), `tsconfig.server.json`, one `<script>` tag in
`index.html`, a `/api` dev proxy and a `dev:api` script. **No new dependency and
`src/**` unchanged** — the client was finished and had to stay that way, which
is what `e2e/llm-command.spec.ts` passing unmodified proves.

58 server tests, all against a fake provider, so CI needs no key. Both
directions are treated as untrusted: browser input (method, origin,
content-type, an 8 KB streamed cap, 512-character text, closed key set) and
model output (tool call required, 32 filters max, spans clipped).

Stated plainly rather than buried: the endpoint is **unauthenticated** and
backed by a metered vendor key, so anyone who can reach it can spend it. Rate
limiting, size caps, same-origin checks and a vendor spend cap are cost control,
not access control, and on serverless the per-IP bucket is per-instance.
Authentication is the milestone after it, and the README says so.

**Deployment hardening (same day)** closed three defects a review found, each
of which would only have failed in production:

1. **`temperature: 0` made the escalation path a hard break (D32).** Sonnet 5
   returns a 400 for non-default `temperature`/`top_p`/`top_k`, so
   `APSIS_MODEL=claude-sonnet-5` would have turned every command into a 502 and
   silently demoted every user to the grammar. No sampling parameters are sent
   now, on any model — deliberately not a per-model capability table, which
   would fail as a production 400 rather than a red test.
2. **Vercel request cancellation is opt-in per path (D33).** Without
   `supportsCancellation` in `vercel.json` the handler's abort logic looks
   correct and never runs: every abandoned request completes and is billed. A
   test now walks `api/` and requires an entry for every function.
3. **The rate limiter's cleanup could never fire (D34).** It tested
   `perHour.length === 0` immediately after pushing the current timestamp, so
   the identity table grew for the life of an instance. Replaced with one map
   per identity and an amortised five-minute sweep; `RateLimiter.size()` is what
   makes reclamation testable at all.

## Current milestone: authentication and access control (contract only)

The endpoint is the first thing Apsis has that costs money to call, and it is
still unauthenticated — the primary production blocker. Contract:
`docs/CONTRACT_AUTHENTICATION.md`, **not implemented**.

**Approach:** a managed provider (WorkOS AuthKit) with a hosted sign-in page, a
server-to-server code exchange, and a session cookie **Apsis seals itself** with
`node:crypto`. No browser SDK, no password handling, **no Apsis database and no
new dependency**. Chosen on what happens when agencies arrive rather than on DX:
every self-hosted path means hand-building organization membership, invitations
and roles — and a database — at the moment the product is trying to sell, while
the provider's token already carries `sub`, `sid`, `org_id`, `role` and
`permissions`.

**Three decisions (D36–D38):** identity is derived from the sealed cookie and
never received from the browser; the IP limiter runs before authentication and
authentication runs before the request body is read, so an unauthenticated
request is refused before its payload arrives; and the dev bypass is *absent*
from the production bundle rather than disabled by a flag — no `?auth=off`, no
environment switch, proven by an import-graph test.

**v1 gates the interpreter, not the application.** Gating the whole app would
protect nothing that needs protecting today — the lead book is seeded
client-side with no real customer data — and would break the "no credential
needed to work on Apsis" promise. The trigger for changing that is written down:
the moment real customer data is served from the server, the app-wide gate
becomes mandatory.

**Two limitations designed in and recorded, not hidden:** a stolen cookie stays
usable for up to 15 minutes, because with no Apsis-owned store the provider is
only consulted at the refresh boundary; and rate limits stay per-instance cost
control rather than durable quotas. Those two are the only things that would
justify adding a database.

**No real-key call has been made.** Request and response shapes are asserted
against the current published API (model ids, forced `tool_choice`, and the
sampling restriction were each confirmed against platform.claude.com during the
hardening pass) but not against the live one. The README carries the exact
smoke-test command; running it is the first thing to do with a key in hand.
