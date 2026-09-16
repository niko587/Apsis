# Progressive lead reveal through drill depth — implementation contract

_Written 2026-09-16 by Opus after inspecting the code and measuring the real
book. Binding for the implementation phase._

## A. Root cause — three separate gaps, one symptom

The owner drilled `West → Colorado → Colorado Springs → Supplemental` and still
had to click particles to find Claire Moreau. Why, exactly:

**1. The Leads list is drill-blind.** `LeadList` filters on `matched` — the
command-bar result set — and nothing else. `grep` for `drill|useDrill|
readDrillPath|matchesPath` in `src/ui/LeadList.tsx` returns **no hits**. Drilling
dims the *field* and updates the *breadcrumb*, but the rail roster keeps showing
the same global top-150 by score. The drilled cluster and the list are unrelated.

**2. The cap hides the cluster.** `VISIBLE_CAP = 150` over 4,892 leads is 3% of
the book, ordered by score. A lead in a deep cluster with a mid-range score is
simply not in the list at any depth.

*(This is also why the §14 e2e test "worked": Claire Moreau is the single booked
lead at 400 leads, so she sits at the top of the global list by luck, not
because drilling revealed her. The test passed for the wrong reason.)*

**3. Hover is one-directional.** The list sets `hoveredLeadId` on row hover, and
`LeadDetail` reads it — but **`src/universe/` never reads `hoveredLeadId` at
all** (zero hits). Hovering a row does not light its particle, and hovering a
particle does not indicate its row. There is no way to correlate the two.

There is also **no search anywhere**. The command bar is a grammar over the
whole book, not a find-by-name within the current cluster.

Net: at full depth the user faces a dimmed field whose lit cluster is unlabelled,
beside a list that may contain none of its members. Particle-guessing is the
only remaining option, exactly as reported.

## B. Desired behaviour per depth — sized to the measured book

Cluster sizes, measured on the default 4,892-lead book (`?leads=4892`, seed
`0x5f3a21`):

| depth | clusters | min | p50 | p90 | max |
|---|---|---|---|---|---|
| Region | 4 | 924 | 1,249 | 1,695 | 1,695 |
| State | 50 | 5 | 59 | 228 | 655 |
| City | 86 | 5 | 35 | 123 | 487 |
| **Segment (full)** | **570** | **1** | **5** | **19** | **81** |

Only 28 of 570 full-depth clusters exceed 25 leads; **9 exceed 50; none exceed
81.** The existing 150 cap therefore **can never truncate a full-depth cluster**.

| depth | roster behaviour | search |
|---|---|---|
| **GLOBAL** | unchanged — top 150 of the book by score, "N total" | hidden |
| **REGION** | top 150 *of the region*, header names the region and states the remainder | shown |
| **STATE** | top 150 *of the state* — covers p90 (228) partially, median (59) completely | shown |
| **CITY** | complete for ~97% of cities (p90 = 123 < 150); top 150 otherwise, remainder stated | shown |
| **SEGMENT** | **complete, always. Every member listed. No cap reachable.** | shown |
| **INDIVIDUAL** | roster stays, selected row marked; §14 focus drives the field | shown |

**The core requirement is met by making the existing list drill-aware.** At full
depth the roster is a complete, short, name-ordered-by-score list of the exact
cluster — a known lead is found by reading, not by guessing.

Header must state the truth at every level, in the existing voice: e.g.
`Leads · Supplemental · 5 in cluster` and, when capped,
`showing 150 of 487 · narrow the drill or search`. **Never show a truncated list
that looks complete** — that is the D12 class of failure.

## C. State model — one addition, deliberately scoped

`selectedLeadId` and `hoveredLeadId` remain the single sources of truth. **Do not
add a second selection.**

One genuinely new piece of state is required: the roster's **search string**.
It is a view concern (like `cursor`, which already lives in `LeadList` as
`useState`), so it belongs in local component state, **not** the store. It must
not be persisted, must not enter the event log, and must reset when the drill
path changes — a filter left over from another cluster is a lie about what is
on screen.

`matched` (command bar) and the drill path are **independent subsetting
mechanisms and must compose**: a lead appears in the roster only if it passes
`matchesPath(lead, path)` **and** the `matched` filter **and** the search string.
That ordering already exists for the field's `lit` calculation — mirror it.

## D. Membership source of truth

`matchesPath(lead, path)` from `src/universe/clusters.ts` — the same predicate
the field uses for dimming and `CameraRig` uses for framing. **Do not write a
second membership rule**; three implementations of "is this lead in the cluster"
will disagree eventually.

`clusterChildren` already walks the book for the breadcrumb on a throttled
cadence. The roster's own pass must stay inside the existing
`useThrottledRevision` + `useMemo` gate keyed on `[leads, matched, path,
search, revision]`. **No per-frame work, no new store subscription in the frame
loop.**

## E. List ⇄ field synchronisation

- **Row → particle:** hovering or keyboard-focusing a row sets `hoveredLeadId`
  (already wired). The field must respond — see F.
- **Particle → row:** the field already sets `hoveredLeadId` on pointer move.
  The roster must mark the matching row (`data-hovered`, a subtle background —
  reuse the existing `.cursor` treatment's language, not a new colour).
- **Selection:** clicking a row or a particle sets `selectedLeadId`; both
  surfaces mark it; §14 focus engages when at full depth. Unchanged.
- **Auto-scroll on selection only, never on hover.** A list that scrolls under a
  moving cursor is unusable; the existing `move()` already scrolls on keyboard
  navigation, which is correct.

## F. Hover in the field — the missing half

The field must show which lead the pointer or keyboard is on. **Do not** write
`aSize`/`aColor` per frame for one index: that re-uploads the whole attribute
(19 KB at the default book, 240 KB at 60k) — the trap recorded in the §14
contract.

Use the pattern that already works: a **second billboarded ring mesh**, sibling
of the existing selection marker in `LeadField`, positioned from
`current[idx*3]` through the field quaternion, `visible` only when
`hoveredLeadId` is set and differs from `selectedLeadId`.

- Cost: **+1 draw call while hovering, 0 otherwise.**
- Visually subordinate to both the §14 reticle and the selection marker — thinner,
  dimmer, no pulse. It answers "which one is that", not "this is the subject".
- Under reduced motion it is static (it should be static anyway).

## G. Selection behaviour

Unchanged from today, plus: selecting from the roster at full depth must engage
§14 focus exactly as a field click does — `isIndividualFocus` already gates on
selection + depth + membership, so this requires no new logic if the roster only
ever offers members of the current cluster (it does, by D).

Selecting a lead **must not alter the drill path**. Escape order stays:
selection first, then one drill level (`UniverseOverlay`).

## H. Search behaviour

- A single text input in the roster header, visible from depth ≥ 1.
- Filters the **current cluster subset only**, case-insensitive, on `name`.
  Matching other fields (segment, location) is permitted but must not surprise:
  if it matches on something other than the name, the row must show why.
- **Never searches outside the current drill path.** A search that reaches the
  whole book is the command bar's job, and conflating them makes both unclear.
- Empty result must say so explicitly: `no leads match "moreau" in this cluster`
  — never an empty box.
- Clears on drill-path change.
- It is a filter, not a command: no Enter-to-execute, no side effects.

## I. Keyboard and accessibility

- The roster remains `role="listbox"` with `aria-activedescendant`; existing
  arrow / PageUp / PageDown / Home / End / Enter / Escape behaviour is preserved
  exactly.
- **Arrow Down from the search input moves into the list**; Escape in the input
  clears the search (it already never reaches the global handler —
  `UniverseOverlay` skips inputs).
- The full pointer-free path must work: drill via breadcrumb buttons → Tab to
  search → type → Arrow Down → Enter → §14 focus engages.
- **`SelectionAnnouncer` remains the only announcer.** The roster must not add a
  live region; the §14 card stays `aria-hidden`. One selection, one announcement.
- The roster header count must be real text, not a decoration — a screen-reader
  user learns cluster size the same way a sighted one does.

## J. Responsive

The roster lives **in the existing rail**, so it inherits the layouts already
proven: `≤1100` narrower rail, `≤820` rail stacks beneath a 46vh stage and
scrolls. **No new floating panel**, therefore no possibility of overlapping the
command bar or the §14 card.

The search input must not push the list out of the rail's scrollable band — the
rail already scrolls (D12) and every list owns a bounded band; keep that.

## K. Performance

- 4,892-lead book, one-draw-call field, no per-lead React components (rows are
  capped at 150 DOM nodes today and must stay capped).
- Round 7 baseline: bloom `resolutionScale 0.5`, DPR 2, **zero live backdrop
  sampling** — the search input and roster use the existing gradient glass.
- Roster recompute stays on the throttled revision, not per frame.
- Hover ring: +1 draw call only while hovering.
- **Total budget: +1 draw call, zero per-frame allocation, no new full-screen
  pass.**

## L. Files that may change

- `src/ui/LeadList.tsx` — drill-aware filtering, search, hovered-row marking
- `src/universe/LeadField.tsx` — hover ring only (sibling of the existing marker)
- `src/App.css` — additive rules for the search input and hovered row
- `src/universe/UniverseOverlay.tsx` — **only** if the breadcrumb needs to point
  at the roster; prefer leaving it alone
- new test files

## M. Files that must not change

`src/state/**` · `src/domain/**` · `src/universe/clusters.ts` ·
`src/universe/Core.tsx` · `src/universe/CameraRig.tsx` ·
`src/universe/SelectedLeadFocus.tsx` · `src/orchestrator/**` ·
`src/ui/LeadDetail.tsx` · the `<Bloom>`/`<EffectComposer>` config ·
`package.json` · `.github/**`

## N. Acceptance tests

1. **The reported bug, as a test.** Drill `West → Colorado → Colorado Springs →
   Supplemental` on the default 4,892-lead book and assert every member of that
   cluster is present in the roster — no cap, no omission — and that selecting
   one by name engages §14 focus.
2. **Roster == cluster.** At every depth, roster membership equals
   `leads.filter(l => matchesPath(l, path))` intersected with `matched` and the
   search, and the header count equals the true cluster size.
3. **Truncation is always declared.** Where a cap applies, the header states
   "showing X of Y"; where it does not, it does not lie.
4. **Composition.** A command-bar result plus a drill path yields the
   intersection, not either alone.
5. **Bidirectional hover.** Row hover lights exactly one particle; particle
   hover marks exactly one row; neither scrolls the list.
6. **Search.** Finds a known lead by name inside the cluster; never returns a
   lead outside the drill path; clears on path change; empty state is explicit.
7. **Pointer-free path.** Drill → Tab to search → type → ArrowDown → Enter →
   §14 focus, with no mouse.
8. **Announcements.** Exactly one live region names the selection (the existing
   §14 assertion must still pass).
9. **Responsive.** Roster and search usable at 1280×800, 1600×1000, 2560×1440
   and the ≤820 stacked layout; the rail still scrolls (D12 suite stays green).
10. **Performance.** +1 draw call while hovering and no more; no per-frame
    allocation; 165+ unit and 20+ browser tests green.

## O. Opus or Fable?

**Opus.** This is a data-flow and information-architecture milestone — filtering,
membership, list/field correlation, keyboard and announcement semantics. The one
visual element, the hover ring, is a direct copy of the existing selection-marker
pattern and needs no art direction.

**Hand to Fable afterwards only if** the hover/selection/focus emphasis triad
wants deliberate visual hierarchy once all three can be seen together. That is a
polish pass, not this milestone.

## P. The next implementation prompt

> **APSIS — PROGRESSIVE LEAD REVEAL — IMPLEMENTATION**
>
> MODEL: OPUS HIGH. Repo `niko587/Apsis`, branch `main`, checkpoint `<current>`.
>
> Read `docs/CONTRACT_PROGRESSIVE_REVEAL.md` and treat it as binding.
>
> **Fix the reported defect:** after drilling to a segment, the rail's Leads list
> still shows the global top-150 by score and may contain none of the cluster's
> members, so a known lead can only be found by clicking particles. Make the
> roster drill-aware so that at full depth every member of the cluster is listed
> and directly selectable by name, add a search that filters within the current
> cluster only, and close the hover loop so a row and its particle indicate each
> other.
>
> The measured book says the existing 150 cap can never truncate a full-depth
> cluster (max 81 members, median 5) — so the core requirement is mostly a
> filtering change, not a new UI.
>
> **Constraints:** `selectedLeadId` and `hoveredLeadId` stay the only selection
> state; search is local view state that resets on path change; membership comes
> from `matchesPath` and nowhere else; the roster recompute stays on the
> throttled revision; the hover ring is a sibling mesh (+1 draw call while
> hovering), never a per-frame attribute upload; Round 7 baseline and the §14
> camera/reticle/card are untouched; no backdrop-filter; one announcer.
>
> Files allowed in §L, forbidden in §M. Meet all ten acceptance tests in §N,
> including one that reproduces the original bug. Run every gate.
>
> Do not begin the LLM command parsing milestone.
