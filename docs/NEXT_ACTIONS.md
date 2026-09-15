# Next Actions

_Last updated: 2026-09-15. Ordered. Each item: what, why now, acceptance,
suggested model (spec §2)._

## 1. Finish GitHub bootstrap — BLOCKED on owner, partially worked around
**What:** Make GitHub canonical. Local git history now exists (created with
isomorphic-git because the machine had no git binary — see
`CURRENT_STATE.md`). Still needed, in order:
1. Owner clicks **Install** on the macOS "command line developer tools"
   dialog (already triggered), or installs git any other way.
2. Owner creates a GitHub repository (suggested name: `apsis`) and provides
   the remote URL + auth (`gh auth login`, or an HTTPS token).
3. `git remote add origin <url> && git push -u origin main`.
**Acceptance:** `git push` succeeds; repo browsable on GitHub with `/docs`
visible; branch `main` is the working branch.
**Model:** either. **Owner action required for 1–2.**

## 2. Real-GPU performance verification (§20) — owner's machine
**What:** Re-measure the FPS table (4,892 / 20k / 60k leads at ≥1600×1000)
on real hardware; the sandbox is fill-rate-bound and cannot measure it.
Also: confirm the Core shader fix reads smooth in motion (D15).
**Acceptance:** README performance table either re-verified with new numbers
or revised; "Unverified" caveats removed from README/`SELF-CRITIQUE.md`;
verdict on §28 Q11 updated.
**Model:** Opus (measurement discipline), owner present.

## 3. Persistence v1
**What:** Snapshot/rehydrate so reload does not reseed: persist the event log
(or book + log tail) to localStorage/IndexedDB behind a small interface in
`src/state/`, restoring through `ingest` so the one-mutator law holds.
**Acceptance:** reload preserves scores/stages/appointments; a "reset book"
control exists; tests cover snapshot round-trip; D1 untouched.
**Model:** Opus.

## 4. Prove the transport seam with a second source
**What:** Implement a replay source (records a session's `LeadEvent`s to a
file/blob; plays them back) alongside the simulator, selectable via URL param.
This hardens the `source.ts` contract before any real CRM work (Arc A).
**Acceptance:** `?source=replay` reproduces a recorded session
deterministically; simulator unchanged; contract documented in
`ARCHITECTURE.md`.
**Model:** Opus.

## 5. Remaining §15 drill dimensions
**What:** Add `campaign` and `source` fields to the domain + seed (weighted,
deterministic), then registry entries for campaign / source / agent /
timeframe; UI needs nothing new (registry-driven).
**Acceptance:** each new dimension drills and partitions (>1 child, counts
sum to members — existing test pattern); parser optionally learns
`from <campaign>` later.
**Model:** Opus (domain), no visual work needed.

## 6. §14 spatial individual transition
**What:** At full drill depth + selection, resolve the lead in-field (camera
completes the approach; a compact in-scene card or emphasized node), demoting
the rail panel to secondary.
**Acceptance:** Universe → cluster → individual reads as one continuous
camera journey; reduced-motion path preserved; a11y parity (selection still
announced, panel still exists).
**Model:** Fable, with the CameraRig contract from `ARCHITECTURE.md`.

## 7. LLM command parsing (opt-in)
**What:** `parseCommand` alternative returning the same `LeadQuery` via a
model call, gated on a configured key; grammar remains the fallback; ignored-
words honesty must survive (model must report unmapped clauses).
**Acceptance:** with no key, behaviour identical to today; with key, novel
phrasings parse; funnel/execution untouched.
**Model:** Opus.

## 8. CI on GitHub (after item 1)
**What:** Actions workflow: `npx tsc -b`, `npx vitest run`, `npx oxlint`,
`npm run build` on push/PR.
**Acceptance:** green run on `main`; badge in README.
**Model:** either.

---

### Standing protocol reminder
After every meaningful phase: update `CURRENT_STATE.md` (+ this file), append
to `DECISIONS.md` if an invariant was added, sync `project-state.json`, and
commit docs together with the change they describe
(`AI_DEVELOPMENT_PROTOCOL.md`).
