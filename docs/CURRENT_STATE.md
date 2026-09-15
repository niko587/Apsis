# Current State

_Last updated: 2026-09-15 (end of the shader-fix + nationwide-book phase)_

This file is the snapshot an external AI project manager should trust over any
conversation history. It describes the repository as it actually is.

## Health

| Check | Status | Command |
|---|---|---|
| TypeScript | clean | `npx tsc -b` |
| Tests | **88 / 88 passing** (8 files) | `npx vitest run` |
| Lint | exit 0 (warnings only, see below) | `npx oxlint` |
| Production build | green, ~1.26 MB bundle (347 KB gz) | `npm run build` |
| Runtime console | 0 errors at load and through drill/command flows | — |

Run locally: `npm install && npm run dev` (port 5173) or
`npx vite preview --port 4173` after a build. URL params: `?leads=N` book
size, `?fx=off` disables post-processing.

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

## In flight right now

Nothing mid-edit. The working tree is consistent and all checks are green.
The next planned work is in `NEXT_ACTIONS.md`.

## Git / GitHub state

- The repo had **no version control at all** until 2026-09-15 — git was not
  installed on this machine (no Xcode CLT). `.gitignore` existed from the
  Vite scaffold.
- Status of the workaround and the push path is tracked in `NEXT_ACTIONS.md`
  item 1. **There is no GitHub remote yet**; nothing has ever been pushed.
  A repo URL + credentials (or `gh auth login` once CLT is installed) are
  needed from the project owner.

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
