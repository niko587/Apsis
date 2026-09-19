# AI Development Protocol

_Rules of engagement for any AI (or human) resuming this project. Written
2026-09-15 so that no local conversation history is ever required._

## Onboarding read order

1. `docs/PROJECT_CONTEXT.md` — what this is, what it is NOT (Cortex), where
   things live, machine gotchas.
2. `docs/CURRENT_STATE.md` — trusted snapshot; supersedes memory and chat.
3. `docs/ARCHITECTURE.md` — the one law and the module map.
4. `docs/FEATURE_INVENTORY.md` — real vs partial vs simulated vs missing.
5. `docs/NEXT_ACTIONS.md` — what to do; `docs/PROJECT_MASTER_PLAN.md` — why.
6. `README.md` + `SELF-CRITIQUE.md` — deep rationale and the honest audit.
7. The spec, `APSIS_MASTER_BUILD_PROMPT.md` (outside the repo) — for any `§n`.

## Invariants — do not break, do not "improve"

1. **`ingest(event)` is the only mutator.** No `setScore`, no `moveLead`, no
   tweens. Movement is derived from score, period (D1, spec §27.3).
2. **The 3D layer holds no authoritative state** and re-derives from the
   store per frame. Stores live in `src/state/`, never `src/universe/`.
3. **No timer-driven fake progress, no invented backend behaviour** (§27).
4. **Orchestrator honesty** (§37): never hardcode model availability; never
   mark a routing decision executed except via `confirmExecution()`; ASSISTED
   mode blocks rather than inventing plans.
5. **The centre means a booking.** Positive events damp to zero at
   `TOUCH_CEILING`; only `appointment_booked` crosses (D3).
6. **A11y parity**: the canvas is `aria-hidden`; any new visual information
   must also exist as real DOM (D8). Respect `prefers-reduced-motion` —
   remove motion that carries no information, shorten motion that does.
7. **The parser reports what it did not understand** (D6). Any replacement
   must keep the ignored-words contract.
8. **No raw elapsed seconds in shader noise domains** — wrapped phases over
   periodic lattices (D15).
9. **Apsis is not Cortex.** Never rename, merge, or import from
   `~/Downloads/cortex`.
10. **Never rewrite published history on `main`** (force-push, rebase of
    pushed commits) without explicit owner instruction (D19).

## Verification discipline

- Check suite (run all four before claiming done):
  ```
  export PATH=/usr/local/bin:$PATH   # node lives only here on this machine
  npx tsc -b && npx oxlint && npx vitest run && npm run build
  ```
- **Rendered ≠ reachable** (D12): for any UI change, verify with a real
  browser (Playwright) that elements are visible at realistic viewports AND
  clickable — geometry + `elementFromPoint` + an actual click. Green
  types/tests/lint said nothing while five panels were unreachable.
- **Never quote FPS from this machine's headless browser** — it software-
  rasterizes (~4 FPS for one triangle). CPU-side claims are measurable
  (disable WebGL); GPU-side claims need the owner's real hardware.
- **Measure before fixing.** The Core-glitch diagnosis handed to Fable blamed
  hash precision; float32 emulation disproved it and found the real causes
  (D15). Cheap numeric emulation beats a plausible story.
- Machine contention is real here: prefer detached runs
  (`(cmd > /tmp/x.log 2>&1; echo DONE >> /tmp/x.log) &` then poll); a vitest
  timeout under load is suspicious, not conclusive. Whole-book tests use
  aggregate-then-assert (D18).
- Tests live beside their modules; the seed is deterministic — assertions may
  depend on the fixed seed (0x5f3a21) and NOW=1_700_000_000_000 but must not
  depend on wall clock.

## Model routing for the work itself (spec §2)

- **Opus**: architecture, domain/state/events, integration, debugging, data,
  tests, docs.
- **Fable**: Three.js/R3F, GLSL, particles, choreography, visual polish.
- The owner switches models manually. If the current task would materially
  benefit from the other model, say exactly: "Switch to [MODEL] for this
  phase" and provide the next instruction verbatim. Never pretend a switch
  happened. Handoff content per spec §34 goes into `CURRENT_STATE.md` /
  `NEXT_ACTIONS.md`, not chat.

## Documentation protocol (standing, per owner instruction 2026-09-15)

After **every meaningful development phase**:
1. Update `docs/CURRENT_STATE.md` (health table, landed list, real-vs-sim).
2. Update `docs/NEXT_ACTIONS.md` (remove done, add discovered).
3. Append to `docs/DECISIONS.md` if any new invariant/trade-off was made.
4. Sync `docs/project-state.json`.
5. Commit docs **together with** the implementation they describe; push to
   `main` at `git@github.com:niko587/Apsis.git` (SSH — see D19; do not switch
   the remote to HTTPS, this machine's git has no CA bundle).
6. **Read the CI run for the commit you pushed** (D71). Local green is not CI
   green, and there is no `gh` here — the public API needs no credential; the
   calls are in `CURRENT_STATE.md` → "Git / GitHub state". Do not write "no
   known failing tests" while the latest run on `main` is red.

Commit style: imperative subject, body says why, ends with
`Co-Authored-By: Claude <model> <noreply@anthropic.com>`. Do not commit
`node_modules`, `dist`, logs (`.gitignore` covers these).

## When blocked

Finish everything not blocked, then state plainly what is blocked, why, and
the exact owner action needed (see NEXT_ACTIONS 1 for the git example). Do
not simulate the blocked thing working.
