# Next Actions

_Last updated: 2026-09-15 (end of the hardening phase). Ordered. Each item:
what, why now, acceptance, suggested model (spec §2)._

**Closed since the last revision:**
- GitHub bootstrap. Remote exists, `main` canonical, `/docs` browsable (D19).
- **Browser reachability suite** — `e2e/reachability.spec.ts`, 8 tests across
  3 viewports, green locally, *proven* to catch D12 by reverting the rail (D20).
- **CI** — `.github/workflows/ci.yml`, five gates on push/PR, badge in README.
- **Performance diagnosis** — `docs/PERFORMANCE_BASELINE.md` (2026-09-15).

**Open defect (not a product bug):** CI is red. The reachability suite's
`inViewport` check demands *total* containment, and on the runner's Linux font
metrics the last rail panel lands 2px past the viewport bottom while remaining
genuinely reachable (`receivesPointer=true`, hit resolves to the `h2`). Passes
on macOS, fails on the runner. Fix is to require the hit-tested point in the
viewport rather than the whole box — still catches D12, whose failure had
`top=1322 bottom=1350` against a 1000px viewport and `hitAt centre=null`.

The owner reports subjective grade **D** on a 2020 M1 MacBook Air. That is now
the project's top priority. Round 1's hypothesis was refuted by real hardware;
item 1 is the ~90-second run that ranks what is left.

## 1. A/B the round-7 optimisation in Safari — BLOCKED on owner, ~1 minute
**What:** `npm run build && npm run preview -- --port 4173`, then drag the
universe for ~20s in each:
```
http://localhost:4173/                 # optimised (new shipping)
http://localhost:4173/?legacyfx=1      # exactly what shipped before (pixel-identical)
```
Answer two questions — the second matters as much as the first:
1. Does the optimised path feel smoother?
2. **Can you see any visual difference at all?** If the panels read as cheaper
   or flatter, say so; the alpha is one line to retune.
Then `http://localhost:4173/?matrix=1` again for numbers comparable to round 6.
**Why now:** round 7 removed all four backdrop blurs from shipping CSS and
halved the bloom render resolution. Visual fidelity is verified by pixel diff
(full page mean 0.42/255; `?legacyfx=1` reproduces the old look exactly), but
**no performance gain is claimed** — the measuring machine cannot resolve the
change and reported the optimised path slower on a tiny, noisy sample.
**Acceptance:** subjective verdict on both smoothness and fidelity, plus a
matrix table; `PERFORMANCE_BASELINE.md` updated with the result.
**Model:** Opus. Fable only if the owner reports a genuine visual downgrade.

## 1-cheap. Also worth one minute: OrbitControls damping
Every round has measured healthy frame delivery while the owner reports lag.
`OrbitControls` uses `enableDamping` with `dampingFactor: 0.06` — a slow
constant, so the camera keeps gliding after input stops. That reads as lag at
any frame rate and is not a performance problem. **Never tested.** If the
complaint is "the camera feels heavy / keeps moving after I let go" rather than
"the picture stutters", this explains more than anything measured so far.

## 1-old. (closed) `?matrix=1` on the M1 — RUN, no configuration in distress
Baseline ~59fps; p99 spanned only 23–27ms across ten cases; two work-removing
cases measured worse. Cleanest was `fx=off backdrop=off` (p99 23, max 32, zero
frames >33ms). Recorded in `PERFORMANCE_BASELINE.md` round 7 §A.

## 1-older. (closed) Safari `?backdrop=off` A/B — RUN, contributor confirmed (partial)
Owner verdict: **noticeable improvement, significant lag remains.** The four
backdrop blurs are a real contributor, not the primary cause. Preserved for a
later cosmetic fix; not optimised yet. Also: Safari ≈ Chrome subjectively on
careful re-comparison, retiring the WebKit-specific hypothesis.

## 1-older. (closed) dev-vs-production A/B — RUN, both feel equally bad
Retires the build-mode hypothesis: StrictMode and unminified React are not the
explanation. Owner is on **Safari**, which also means every prior
"0 long tasks" reading was a false negative (fixed this round).

## 1-older. (closed) jank/interaction probes on the M1 — RUN, production measures healthy
idle p99 26 ms / drag p99 23 ms, max 28 ms, **zero** frames over 33 ms in the
drag sweep, zero long tasks, no input event over 16 ms. Recorded in
`PERFORMANCE_BASELINE.md` round 4. Treated as evidence the harness measures
something other than what the owner experiences — not that the app is fine.

## 1-older. (closed) `?bench=1` on the M1 — RUN, median uninformative
All nine configurations returned 58.8 fps / 17.0 ms, including `field=off` and
`core=off`. That is the vsync interval quantised, not a finding. Recorded in
`PERFORMANCE_BASELINE.md` round 3.

## 1a. (closed) The `fx=off` A/B — RUN, hypothesis refuted
Result: normal FX difficult to use; `?fx=off` some improvement, still difficult.
Post-processing contributes; it is not primary. Recorded in
`PERFORMANCE_BASELINE.md` round 2.

## 1b. Free wins, safe to do regardless of the A/B outcome
**What:** Baseline items 3 and 4 — precompute stage colours as RGB triples so
no colour string is ever parsed in a hot path, and add an out-parameter
`positionInto(lead, out)` so the frame path allocates nothing.
**Why now:** `THREE.Color.setStyle` is the measured hottest JavaScript function
in the app (273 ms/8 s at 60k leads, ~48% of non-rasterizer JS self-time), and
`positionFor` allocates one object per lead per event. Both are small,
behaviour-preserving, and independent of which bottleneck wins.
**Acceptance:** no `Color.set(string)` or per-lead allocation on any per-frame
or per-event path; visual output unchanged; unit tests still green; re-measured
(the claim must be a measurement, not an assumption).
**Model:** Opus. **Do not start before the project manager reviews the
baseline.**

## 2. Prove the transport seam with a second source (replay)
**What:** Implement a replay source (records a session's `LeadEvent`s to a
file/blob; plays them back) alongside the simulator, selectable via URL param.
**Why now — reordered ahead of persistence:** three
reasons. (a) It hardens the `source.ts` contract with a genuine second
implementation, which is the prerequisite for any real CRM work (Arc A) — the
single largest gap in the product. (b) Deterministic session reproduction
makes item 1's perf comparisons and any future bug repro repeatable instead of
two different random runs. (c) It builds the event-log serialization that
persistence needs anyway, shrinking item 3 to "write the same log to
IndexedDB".
**Acceptance:** `?source=replay` reproduces a recorded session
deterministically; simulator unchanged; contract documented in
`ARCHITECTURE.md`.
**Model:** Opus.

## 3. Persistence v1
**What:** Snapshot/rehydrate so reload does not reseed: persist the event log
(or book + log tail) to localStorage/IndexedDB behind a small interface in
`src/state/`, restoring through `ingest` so the one-mutator law holds.
**Why it moved down:** with only the simulator feeding events, this durably
stores *fabricated* data — real value arrives with a real source. Item 2 also
builds most of its foundation.
**Acceptance:** reload preserves scores/stages/appointments; a "reset book"
control exists; tests cover snapshot round-trip; D1 untouched.
**Model:** Opus.

## 4. Remaining §15 drill dimensions
**What:** Add `campaign` and `source` fields to the domain + seed (weighted,
deterministic), then registry entries for campaign / source / agent /
timeframe; UI needs nothing new (registry-driven).
**Acceptance:** each new dimension drills and partitions (>1 child, counts
sum to members — existing test pattern); parser optionally learns
`from <campaign>` later.
**Model:** Opus (domain), no visual work needed.

## 5. §14 spatial individual transition
**What:** At full drill depth + selection, resolve the lead in-field (camera
completes the approach; a compact in-scene card or emphasized node), demoting
the rail panel to secondary.
**Acceptance:** Universe → cluster → individual reads as one continuous
camera journey; reduced-motion path preserved; a11y parity (selection still
announced, panel still exists).
**Model:** Fable, with the CameraRig contract from `ARCHITECTURE.md`.

## 6. LLM command parsing (opt-in)
**What:** `parseCommand` alternative returning the same `LeadQuery` via a
model call, gated on a configured key; grammar remains the fallback; ignored-
words honesty must survive (model must report unmapped clauses).
**Acceptance:** with no key, behaviour identical to today; with key, novel
phrasings parse; funnel/execution untouched.
**Model:** Opus.

---

### Standing protocol reminder
After every meaningful phase: update `CURRENT_STATE.md` (+ this file), append
to `DECISIONS.md` if an invariant was added, sync `project-state.json`, and
commit docs together with the change they describe
(`AI_DEVELOPMENT_PROTOCOL.md`). The remote now exists — push to `main`.
