# Next Actions

_Last updated: 2026-09-16 (LLM command parsing contract). Ordered. Each item:
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

Arc A, Persistence v1, §15 drill dimensions, §14 spatial individual focus and
progressive lead reveal are all closed — the last two **owner accepted**. The
current milestone is **LLM command parsing (opt-in)**, contract at
`docs/CONTRACT_LLM_COMMAND_PARSING.md`, not yet implemented.

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
Apsis deliberately cannot supply one. Until a host declares it, the grammar runs
and this code is inert.

**One deviation from the contract, flagged rather than buried:** the response
envelope gained an optional `actionSpan`. §G specified provenance for filters
and left `action` uncited, which would have forced a choice between reporting
"call" as ignored while agents were being dispatched, or exempting the verb from
the residue and trusting it silently. Requiring a citation makes one rule cover
everything — no provenance, no effect (D28).

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
