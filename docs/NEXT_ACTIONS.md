# Next Actions

_Last updated: 2026-09-15 (post-GitHub-bootstrap re-ordering). Ordered. Each
item: what, why now, acceptance, suggested model (spec §2)._

**Closed since the last revision:** GitHub bootstrap (old item 1). The remote
exists, `main` is pushed and tracking, `/docs` is browsable. Mechanics and
gotchas are recorded in `CURRENT_STATE.md` → "Git / GitHub state" and D19.

## 1. Real-GPU performance verification (§20) — BLOCKED on owner's machine
**What:** Re-measure the FPS table (4,892 / 20k / 60k leads at ≥1600×1000)
on real hardware; the sandbox is fill-rate-bound and cannot measure it.
Also: confirm the Core shader fix reads smooth in motion (D15).
**Why now:** it gates ordering. If 60k leads is slow on real hardware, the
render path outranks every feature item below, and items 4–8 get re-sorted.
Nothing below should be treated as settled priority until this is known.
**How:** `npm run build && npx vite preview --port 4173`, then `?leads=20000`
and `?leads=60000`; `?fx=off` isolates post-processing cost.
**Acceptance:** README performance table either re-verified with new numbers
or revised; "Unverified" caveats removed from README/`SELF-CRITIQUE.md`;
verdict on §28 Q11 updated.
**Model:** Opus (measurement discipline), owner present.

## 2. Browser reachability smoke test — automate D12
**What:** A Playwright suite that loads the app and asserts, for every rail
panel and the command bar, that the element is **in the viewport and actually
receives a click** (geometry + `elementFromPoint` + a real click), at
1280×800, 1600×1000 and 2560×1440.
**Why now:** the rail-overflow bug (D12) shipped with types, 88 unit tests,
lint, build *and* the responsive audit all green — none of them can see a
panel that is laid out correctly 186px below an unscrollable fold.
`AI_DEVELOPMENT_PROTOCOL.md` already mandates this check for UI changes, but
as unautomated discipline, which is exactly the kind that lapses. Every item
below ships on this suite; make it honest first.
**Acceptance:** suite fails when the rail is reverted to `overflow: hidden`
(prove it by actually reverting), passes on `main`; runs headless; wired into
the check suite and `package.json` scripts.
**Notes:** headless Chromium here software-rasterizes — fine for geometry and
clicks, **never** for FPS (protocol rule). Use a small `?leads=` and `?fx=off`
to keep it quick.
**Model:** Opus.

## 3. CI on GitHub — unblocked by item 1's closure
**What:** Actions workflow: `npx tsc -b`, `npx vitest run`, `npx oxlint`,
`npm run build`, plus item 2's smoke test, on push/PR.
**Why now:** cheap, and it moves the whole check suite off a single machine
with a hand-built git and no CLT.
**Acceptance:** green run on `main`; badge in README.
**Model:** either.

## 4. Prove the transport seam with a second source (replay)
**What:** Implement a replay source (records a session's `LeadEvent`s to a
file/blob; plays them back) alongside the simulator, selectable via URL param.
**Why now — reordered ahead of persistence (was item 4, behind it):** three
reasons. (a) It hardens the `source.ts` contract with a genuine second
implementation, which is the prerequisite for any real CRM work (Arc A) — the
single largest gap in the product. (b) Deterministic session reproduction
makes item 1's perf comparisons and any future bug repro repeatable instead of
two different random runs. (c) It builds the event-log serialization that
persistence needs anyway, shrinking item 5 to "write the same log to
IndexedDB".
**Acceptance:** `?source=replay` reproduces a recorded session
deterministically; simulator unchanged; contract documented in
`ARCHITECTURE.md`.
**Model:** Opus.

## 5. Persistence v1
**What:** Snapshot/rehydrate so reload does not reseed: persist the event log
(or book + log tail) to localStorage/IndexedDB behind a small interface in
`src/state/`, restoring through `ingest` so the one-mutator law holds.
**Why it moved down:** with only the simulator feeding events, this durably
stores *fabricated* data — real value arrives with a real source. Item 4 also
builds most of its foundation.
**Acceptance:** reload preserves scores/stages/appointments; a "reset book"
control exists; tests cover snapshot round-trip; D1 untouched.
**Model:** Opus.

## 6. Remaining §15 drill dimensions
**What:** Add `campaign` and `source` fields to the domain + seed (weighted,
deterministic), then registry entries for campaign / source / agent /
timeframe; UI needs nothing new (registry-driven).
**Acceptance:** each new dimension drills and partitions (>1 child, counts
sum to members — existing test pattern); parser optionally learns
`from <campaign>` later.
**Model:** Opus (domain), no visual work needed.

## 7. §14 spatial individual transition
**What:** At full drill depth + selection, resolve the lead in-field (camera
completes the approach; a compact in-scene card or emphasized node), demoting
the rail panel to secondary.
**Acceptance:** Universe → cluster → individual reads as one continuous
camera journey; reduced-motion path preserved; a11y parity (selection still
announced, panel still exists).
**Model:** Fable, with the CameraRig contract from `ARCHITECTURE.md`.

## 8. LLM command parsing (opt-in)
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
