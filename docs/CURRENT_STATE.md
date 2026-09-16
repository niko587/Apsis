# Current State

_Last updated: 2026-09-15 (GitHub bootstrap; previous phase: shader fix +
nationwide book)_

This file is the snapshot an external AI project manager should trust over any
conversation history. It describes the repository as it actually is.

## Health

| Check | Status | Command |
|---|---|---|
| TypeScript | clean (3 projects: app, node, e2e) | `npm run typecheck` |
| Unit tests | **88 / 88 passing** (8 files) | `npm test` |
| Browser reachability | **8 / 8 passing** (3 viewports) | `npm run test:e2e` |
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

## Performance findings (2026-09-15) — see `PERFORMANCE_BASELINE.md`

The owner reports subjective grade **D** (laggy/unusable) on a 2020 M1
MacBook Air. A full diagnosis was run; **no optimization has been applied and
no improvement is claimed.** Headlines:

- **Leads are ONE `THREE.Points` draw call** — there are no per-lead React
  components. 29–40 draw calls per frame at every book size. The usual suspect
  for this symptom is disproven.
- **`fx=off` is worth 4.2× at the default 4,892 leads** (2.1× at 20k, 2.6× at
  60k). Bloom's fragment budget computes to ~4× the entire lead field's. GPU
  fill rate is the **leading hypothesis** — but unprovable here, because this
  machine's software rasterizer produces that signature regardless.
- **The hottest JavaScript function in Apsis is a CSS colour-string parser.**
  `THREE.Color.setStyle`, 273 ms/8 s at 60k leads (~48% of non-rasterizer JS
  self-time), reached because `LeadField` rewalks the **whole book** on every
  ingested event (~9/s) and re-parses `'#2f6bff'` per lead. `positionFor`
  allocates one object per lead on the same path. Real, avoidable, scales
  badly — but only ~2–3% of main-thread samples at the default book, so
  probably not what makes the Air feel like D.
- **Scaling is linear with no cliff** to 60k. The default book is not a
  scaling problem, which points at fixed per-frame cost.
- Measured with runtime-injected instrumentation (Playwright `addInitScript` +
  CDP profiler); **no source file was modified to measure.**

**Round 2 (same day): the fill-rate hypothesis was refuted on real hardware.**
The owner's M1 result — normal FX difficult to use, `?fx=off` *some* improvement
but still difficult — means post-processing contributes but is not primary. The
two machines have genuinely different bottlenecks: here `fx=off` alone restores
the 60 fps vsync cap (15.7 → 60.2), on the Air it barely helps. **No further
measurement on this machine can identify the cause on that one.**

So round 2 shipped an instrument rather than a second guess:
`src/diag/diagnostics.ts` + `src/diag/DiagOverlay.tsx`, a subtractive harness
(`?diag=1`, `?bench=1`, `?dpr=N`, `?field=off`, `?core=off`, `?feed=off`,
`?anim=off`) that times `renderer.render()` against the frame interval to
separate CPU from GPU, and walks the whole matrix automatically in ~90 s.
**Every flag is off by default; a default page load is byte-identical to the
shipping product** (verified: same 9 panels, 150 rows, live feed, full scene,
no overlay). Two facts it already establishes: `render()` CPU time is
0.3–0.5 ms in *every* configuration, which effectively rules out Three.js
object-update cost; and `feed=off` is worth ~22% even against a rasterizer that
dwarfs it, which strengthens the case against the per-event full-book walk.

**Round 3 (same day): the bench median was uninformative, and every candidate
the instruments can see is now eliminated.** All nine M1 rows returned
58.8 fps / 17.0 ms — the vsync interval quantised, which a median always is.
Round 3 therefore measured the tail and the interaction instead: frame-time
p95/p99/max and >20/33/50/100 ms buckets, `longtask`, Event Timing **input
latency**, per-code-path spans, and scripted pointer *and drag* sweeps.

Measured at 4,892 leads (pure JS, transfers between machines): full-book
revision walk 1.7–2.1 ms × ~9/s, `Points.raycast` 0.094 ms (confirmed scanning
all 4,892 — 596,824 points over 122 calls), settled frame loop 0.063 ms,
`ingest` 0.055 ms including every synchronous subscriber. **Total ≈ 2.7% of one
core** — JavaScript cannot account for the owner's lag at this book size.
Ruled out as primary: CPU/JS, React reconciliation, Zustand, raycasting, the
revision walk, draw calls, Three.js object updates — and, from the owner's own
round-2 table, fill rate and post-processing.

**Round 4 (same day): the production build measures HEALTHY on the owner's M1,
and the owner still reports grade D.** Drag sweep: 901 frames, p99 23 ms, max
28 ms, **zero** frames over 33 ms, zero long tasks, no input event over 16 ms.
Idle and pointer sweep similar (p99 26–27 ms). Spans matched this machine
almost exactly. This is read as evidence the harness measures something other
than what the owner experiences — **not** that the app is fine.

Measured dev vs production on the same machine with the same harness: app
spans are **identical** (`revisionWalk` 1.79 vs 1.84 ms, `ingest` 0.05 vs
0.06 ms), but dev carries **~1.9× the main-thread long-task load** (188–196
tasks vs 100–106; 14.5–14.8 s vs 7.9 s) and loads 4.3× slower (529 ms / 63
requests vs 122 ms / 2). The dev penalty — StrictMode double-invoking renders
and effects, unminified React reconciliation — lands in React's work, which
**no instrumented span covers**. A dev session can therefore feel much worse
while every span reads normal.

**Defect disclosed, not patched:** `installLongTaskObserver()` reports
`count=0` when `observe()` throws, and **Safari implements
`PerformanceObserver` but not the `longtask` entry type**. Every "0 long tasks"
line so far is a *false negative* if the runs were in Safari. The report header
also does not record build mode, so two pasted reports are indistinguishable
without labelling. Both are one-line fixes, deferred because round 4 was scoped
to no application-code changes.

**Still no bottleneck confirmed; the owner's report stands unexplained.** Next
action is the dev-vs-production A/B on the Air plus three environment questions
(everyday port, Chrome vs Safari, power/display state) — `NEXT_ACTIONS.md`
item 1.

**Round 5: owner is on Safari; dev ≡ production subjectively, retiring the
build-mode hypothesis.** Enumerated the full graphics/compositor stack and
found what every previous round ignored: **four elements layered directly over
the live WebGL canvas carry `backdrop-filter: blur()`** — `.command-row` and
`.command-out` at 14px (`App.css:321,363`), `.uv-clusters` and `.uv-skills` at
6px (`overlay.css:23`). A backdrop filter makes the compositor sample what is
behind it, blur it and composite — every frame, canvas as source, **after
`requestAnimationFrame` returns**, where no instrument in this repo can see it.

It is the first hypothesis consistent with *all* surviving evidence: JS cheap
(~2.7% of a core), frame intervals perfect (p99 23 ms, zero frames >33 ms),
`fx=off` partial, `field=off`/`core=off` making no difference (**a backdrop
blur costs the same regardless of what is behind it** — which is precisely why
every round-2 toggle returned identical numbers), dev ≡ production (same CSS),
and Safari-specific severity. **It is untested**; `?backdrop=off` decides it in
about a minute.

Diagnostic correctness fixes: the `longtask` false negative is gone (Safari now
prints "LONGTASK OBSERVER UNSUPPORTED", never `count=0`), reports carry
**BUILD MODE** and a capability line (`longtask`, `eventTiming`,
`gpuTimerQuery`, `fenceSync`, GL renderer), and a presentation section reports
rAF lateness, polled **WebGL2 fence** GPU-completion latency and input→handler
latency — with a standing note that **true presentation time is not observable
from JS in Safari** (no frame-timing API, no timer query).

Shipping stylesheets and visuals are byte-identical; the toggles inject a
runtime `<style>` because the CSS minifier rewrote an authored override to
`-webkit-` only, which would have silently disabled the test in Chrome.

Next action: the Safari `?backdrop=off` A/B — `NEXT_ACTIONS.md` item 1.

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

**Absent**: any backend, any persistence (reload = reseed), LLM command
parsing (grammar by deliberate staging choice), programmatic multi-model
invocation (environment provides none; orchestrator correctly reports
ASSISTED).
