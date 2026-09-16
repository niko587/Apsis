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

## 0e. (closed) §14 spatial individual transition — implemented by Fable
Camera completes the approach (was a 45% lean), a stage-coloured reticle
resolves the lead, a tracking glass card confirms it in-scene; rail untouched,
Escape order unchanged, +1 draw call, reduced-motion and a11y contracts held.
Owner M1 verification pending (see VALIDATION note in the commit).

## 1. Progressive lead reveal through drill depth — NEXT MILESTONE
**MODEL: OPUS.** Contract written and committed:
**`docs/CONTRACT_PROGRESSIVE_REVEAL.md`** (root cause, per-depth behaviour,
state model, sync, search, a11y, responsive, performance, file boundaries, ten
acceptance tests, and the implementation prompt in §P).

**The defect:** after drilling to a segment, the rail's Leads list still shows
the global top-150 *by score* and may contain none of the cluster's members, so
a known lead can only be found by clicking particles. Three causes, all
measured: `LeadList` never reads the drill path (zero references); the 150 cap
is 3% of the book; and `src/universe/` never reads `hoveredLeadId`, so hover is
one-directional.

**Why it is mostly a filtering change:** measured on the default book, a
full-depth cluster has **median 5 members, p90 19, max 81** across all 570
clusters — the existing cap can never truncate one. Making the roster
drill-aware delivers "every lead selectable by name at full depth" almost
by itself.

**Model note:** Opus, not Fable — this is data flow and information
architecture. The one visual element (a hover ring) copies the existing
selection-marker pattern. Fable afterwards only if the hover/selection/focus
triad wants a deliberate visual hierarchy once all three are visible together.

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
