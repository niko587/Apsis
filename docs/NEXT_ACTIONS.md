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

## 1. LLM command parsing (opt-in) — **CURRENT MILESTONE**
**MODEL: OPUS.** Contract written and committed:
**`docs/CONTRACT_LLM_COMMAND_PARSING.md`** — current pipeline, the canonical
`LeadQuery`, the single seam, activation, no-key behaviour, provider boundary,
validation, unmapped-clause honesty, fallback table, async/cancellation, UI
states, security and privacy, file boundaries, 15 unit + 7 browser tests,
acceptance criteria, implementation sequence, and the next prompt in §T.

**What:** an alternative front end to `parseCommand` that returns the same
`ParsedCommand` via a model call, opt-in on a host-declared endpoint; the
grammar remains the fallback and the oracle.

**The two findings that shape it:**
1. **Apsis is a browser-only SPA with no server and no `fetch()` in `src/`.** Any
   API key reachable by this app is public — `VITE_*` is inlined at build time.
   So Apsis must never hold a vendor credential or call a vendor API directly;
   it POSTs to an endpoint the host operates. Only the command text and a static
   schema leave the browser — never leads, names, phones, emails or history.
2. **The grammar's honesty is structural, not promised:** it blanks out every
   recognised span, so the residue *is* the unrecognised part. The LLM path must
   earn it the same way — each mapped filter must cite a span that appears
   verbatim in the input, and `unrecognised` is computed by subtraction. The
   model's own account of what it understood is not trusted.

**Acceptance headline:** with no declared interpreter, behaviour is *identical* —
proven by a corpus deep-equal test against `parseCommand` and an assertion that
`fetch` is never called, not by inspection.

## 2. (open defect) Four browser specs red on `main`
Found at b96108d, **after** progressive reveal landed and unrelated to the
contract above. Not yet triaged:
- `e2e/persistence.spec.ts:34`
- `e2e/reachability.spec.ts:275`
- `e2e/spatial-focus.spec.ts:82` (@2560×1440)
- `e2e/spatial-focus.spec.ts:128`

At least one is a stale test assumption rather than a product defect:
`getByRole('option').nth(1)` at `?leads=400` full depth, where the drill-aware
roster now yields a single row. The other three are undiagnosed — **do not
assume they are all stale.** TypeScript, lint and all 165 unit tests are green;
26 of 30 browser specs pass. Triage before or alongside the LLM milestone.

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
