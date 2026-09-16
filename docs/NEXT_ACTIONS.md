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

**Open defect (not a product bug):** CI is red. The reachability suite's
`inViewport` check demands *total* containment, and on the runner's Linux font
metrics the last rail panel lands 2px past the viewport bottom while remaining
genuinely reachable (`receivesPointer=true`, hit resolves to the `h2`). Passes
on macOS, fails on the runner. Fix is to require the hit-tested point in the
viewport rather than the whole box — still catches D12, whose failure had
`top=1322 bottom=1350` against a 1000px viewport and `hitAt centre=null`.

**PERFORMANCE IS CLOSED.** The owner's final A/B on the real 2020 M1 MacBook
Air: dramatically smoother, visual difference tiny and still just as good, and
the original lag is gone. Round 7 (no live backdrop sampling + half-resolution
bloom) is the accepted shipping baseline — see `PERFORMANCE_BASELINE.md`
closeout. Performance is **no longer the top blocker**, and no further rendering
optimisation is warranted or wanted.

The top priority is now the product's own documented largest gap: the real data
boundary (`PROJECT_MASTER_PLAN.md` Arc A).

## 1. Fix the reachability suite's 2px over-strictness — CI is RED
**What:** `e2e/reachability.spec.ts` requires a panel's bounding box to be
*entirely* inside the viewport. On the CI runner's Linux font metrics the last
rail panel lands 2px past the bottom (`top=991 bottom=1002 viewportH=1000`)
while being genuinely reachable — `receivesPointer=true`, and the hit test
resolves to the panel's own `h2`. Require the **hit-tested point** to be in the
viewport rather than the whole box.
**Why now:** it is the only red gate, it is a defect in the test rather than the
product, and it has been failing intermittently since round 5 (round 6 passed by
a pixel of luck). A check suite nobody trusts is worse than none — and this one
exists precisely because D12 shipped with every other gate green.
**Acceptance:** still fails when `.rail` is reverted to `overflow: hidden` —
that regression had `top=1322 bottom=1350` against a 1000px viewport and
`hitAt centre=null`, so it is caught by a mile either way; green on CI twice in
a row. **Not a performance change.**
**Model:** Opus. Small.

## 2. Prove the transport seam with a second source (replay) — NEXT MILESTONE
**What:** implement a replay source that records a session's `LeadEvent`s and
plays them back, alongside the simulator, selectable by URL param.
**Why this is the highest-value product work now that performance is closed:**
`PROJECT_MASTER_PLAN.md` names Arc A, the real data boundary, as **"the single
largest gap"** — everything above `src/state/source.ts` is real and test-covered,
and nothing below it exists. Arc A step 4 is exactly this: a second concrete
source to prove the seam actually swaps. It is the prerequisite for any real CRM
integration, it makes sessions deterministically reproducible (which would have
saved several rounds of the performance investigation), and it builds the
event-log serialization that persistence needs anyway, shrinking item 3.
**Acceptance:** `?source=replay` reproduces a recorded session deterministically;
the simulator is unchanged; the contract is documented in `ARCHITECTURE.md`;
`ingest` remains the only mutator (D1).
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

## 7. Hygiene — colour precompute / `positionInto` (NOT performance-justified)
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
