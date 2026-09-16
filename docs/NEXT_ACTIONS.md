# Next Actions

_Last updated: 2026-09-15 (performance closeout). Ordered. Each item:
what, why now, acceptance, suggested model (spec §2)._

**Closed:**
- GitHub bootstrap. Remote exists, `main` canonical, `/docs` browsable (D19).
- **Browser reachability suite** — `e2e/reachability.spec.ts`, proven to catch
  D12 by reverting the rail (D20). See the open defect below.
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

The top priority is now the product's own documented largest gap: the real data
boundary (`PROJECT_MASTER_PLAN.md` Arc A).

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

## 1. §14 spatial individual transition — NEXT MILESTONE
**MODEL: FABLE.** The contract is written and committed:
**`docs/CONTRACT_14_SPATIAL_INDIVIDUAL.md`** — state model, camera derivation,
emphasis limits, in-scene information, rail relationship, reduced motion, a11y,
responsive rules, exit/unwind, performance guardrails, allowed/forbidden files,
acceptance criteria, and the verbatim implementation prompt in §O.
Opus wrote it after inspecting `CameraRig`, `LeadField`, `drillStore`,
`UniverseOverlay`, `StatusAnnouncer` and the responsive CSS; Fable should read
it first and treat it as binding.

**Prep finding worth knowing before starting:** `CameraRig` already implements a
partial §14 — at full drill depth a selection lerps the camera target 45% toward
the lead's live position. The move exists but never arrives, and nothing in the
scene marks the lead as the subject. This is an extension, not a green field.
**What:** At full drill depth + selection, resolve the lead in-field — the
camera completes the approach and a compact in-scene card or emphasised node
carries the lead, demoting the rail panel to secondary.
**Why now:** it is the last substantial gap in `SELF-CRITIQUE.md`'s §14 entry:
"Universe → Cluster → Individual now *is* a camera move, but the individual
level still resolves into the rail panel rather than into the field." A
presentation miss rather than a navigation one — which is exactly the kind of
thing Fable should take.
**Acceptance:** Universe → cluster → individual reads as one continuous camera
journey; reduced-motion path preserved (the destination carries the
information, so the move is shortened, never removed); a11y parity — selection
still announced, the rail panel still exists and still carries every §14 field.
**Do not regress:** the round-7 rendering baseline, DPR 2, bloom resolution,
zero live backdrop sampling, the 4,892-lead book, the Intelligence Core.

## 2. LLM command parsing (opt-in)
**What:** `parseCommand` alternative returning the same `LeadQuery` via a
model call, gated on a configured key; grammar remains the fallback; ignored-
words honesty must survive (model must report unmapped clauses).
**Acceptance:** with no key, behaviour identical to today; with key, novel
phrasings parse; funnel/execution untouched.
**Model:** Opus.

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
