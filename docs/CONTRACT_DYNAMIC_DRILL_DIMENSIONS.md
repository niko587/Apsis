# Dynamic drill dimensions — architecture and interaction contract

_Written 2026-09-16 by Opus after inspecting the repository at `337afa2`.
Binding for the implementation phase. **Nothing here is implemented yet.**_

§15 registered nine dimensions. Four of them are reachable. This contract is
about the other five — and about nothing else.

---

## A. User mental model

**The field never rearranges. The question does.**

A user is looking at one fixed constellation of 4,892 leads whose positions mean
exactly one thing: distance from a booked appointment. Drilling picks a subset
and lights it; the rest recedes. Choosing a *dimension* changes which subset the
next step can pick — it does not change where anything is.

The sentence that has to stay true after this milestone is the one that was true
before it: **score is the only thing that moves a lead.** Everything below is
constrained by that.

The user-facing idea is one line: *"group what's left by ___ next."* Not
"configure a report", not "build a query". One choice, at the moment it is
relevant, with a sensible answer already filled in.

---

## B. Chosen interaction: **A — choose the next grouping at each level**

Rejected, with reasons:

| model | why not |
|---|---|
| **B. Presets / complete sequences** | Requires naming and maintaining a library of sequences, adds a second concept ("which analysis am I in?") before the user has asked for one, and the moment a preset is nearly-right the user needs per-level control anyway. A preset list is the first step toward a BI dashboard. |
| **C. Full hybrid (presets *and* per-level)** | Two ways to do one thing, and the ambiguity of which one is in charge. |
| **A. Per-level choice** | **Chosen.** Smallest possible addition, because the overlay *already* renders `Drill into city` as a heading at every level. This milestone makes that heading a control. No new concept, no new screen, no new vocabulary. |

**The detail that makes A safe rather than confusing: the default chain is
pre-selected at every depth.** At depth 0 the next dimension is already `Region`,
at depth 1 `State`, at 2 `City`, at 3 `Segment`. A user who never opens the
picker walks exactly today's path and sees exactly today's screen. The picker is
a refinement of a heading that already exists, not a decision the product now
demands.

`DRILL_SEQUENCE` therefore survives — demoted from "the drill order" to "the
default suggestion at each depth". That demotion is the whole architectural
change.

---

## C. Default behaviour

Binding: **with no interaction, the experience is byte-for-byte today's.**

- `GLOBAL → Region → State → City → Segment → individual`.
- The heading reads `Drill into region` as it does now, with an affordance
  beside it rather than in place of it.
- Breadcrumbs for a default path render exactly as today — no dimension labels
  (§M).
- No extra chrome at GLOBAL, no picker open by default, nothing new focused.

The existing browser suite is the enforcement mechanism: `progressive-reveal`,
`spatial-focus` and `reachability` all drive the default path and must pass
**unmodified**.

---

## D. State model

One field is added. Nothing is mirrored.

```ts
interface DrillState {
  path: readonly PathStep[];          // unchanged — the historical truth
  nextDimensionId: string | null;     // NEW. null ⇒ use the default for this depth
  push(step: PathStep): void;         // clears nextDimensionId
  pop(): void;                        // clears nextDimensionId
  reset(): void;                      // clears nextDimensionId
  toDepth(depth: number): void;       // clears nextDimensionId
  chooseNextDimension(id: string | null): void;  // NEW
}
```

**`PathStep` does not change.** `{ dimensionId, key }` is already the complete
record of what the user selected, and it already carries the dimension — the
path has been dimension-explicit since §15. That is why this milestone is small.

**Why `nextDimensionId` lives in `drillStore` and not in the component:** every
navigation action must clear it (a dimension chosen for depth 2 is meaningless
at depth 1), and `pop`/`toDepth` are store actions. Component state would need
an effect to watch `path` and reset — which is precisely the "same state in two
places" the brief forbids, with the usual reward of a stale value after a
breadcrumb jump.

**What is NOT added:**

- No `drillPlan`. There are no presets.
- No `availableDimensions` in state. It is derived, on demand, when the picker
  opens (§F) — keeping it in state would mean recomputing it on every book
  revision for a menu nobody has opened.
- Nothing in `src/universe/`. The 3D layer still owns no state.

---

## E. Path semantics

`matchesPath` is unchanged and remains the single membership predicate for the
field, the camera, the roster and focus. It already iterates `path` and looks up
`DIMENSIONS[step.dimensionId]`, so it is already dimension-agnostic — a dynamic
path is just a path whose dimension ids are not in the default order.

**Partition invariant, restated and still binding:** every dimension must assign
a key to every lead. `agent` returns `UNASSIGNED` rather than null; `timeframe`
has an `older` catch-all. A dimension whose `keyFor` can return `null` for a
lead inside the parent cluster would make that lead vanish from every child, and
is forbidden. (`region`/`state`/`city` return null only for a malformed
location, which the seeded book cannot produce; that is pre-existing and tested.)

---

## F. Available-dimension rules

The picker offers a dimension when it **can actually split the current cluster
into more than one child**, and hides it otherwise.

```ts
export function availableDimensions(
  leads: Iterable<Lead>,
  path: readonly PathStep[],
): ClusterDimension[];
```

One rule, not three, and it subsumes every case the brief asks about:

| case | outcome | why |
|---|---|---|
| dimension already used in this path | hidden | every member shares that key, so it yields one child and cannot narrow anything |
| `region` after `state`, `state` after `city` | hidden | same reason — geography is nested, so the coarser dimension is already determined. **No special-casing is needed**, and none is added |
| `city` after `region` | offered | genuinely splits |
| a dimension where every member happens to share a value | hidden | offering a control that provably changes nothing is noise |
| a dimension with ≥2 distinct values | offered | |
| the cluster is empty | none offered | nothing to split; §H governs the screen |

**Repeats are therefore impossible in practice** without a special rule, because
a repeated dimension always yields one child. That is the reasoning to prefer:
derive the behaviour from the data rather than maintain a "used" set that would
then need geography exceptions bolted on.

**Ordering:** the default-for-this-depth first (so the obvious choice is first),
then the remaining dimensions in registry order. Not by child count — a list
that reorders itself as the feed lands is a list you cannot build muscle memory
for.

**Cost, and why it is computed on open.** Answering "≥2 distinct keys?" for nine
dimensions is one pass over the members with an early exit per dimension once it
has seen two keys. Bounded, but not free — so it runs **when the picker opens**,
not on every render or revision. A menu computes its contents when it is
summoned.

---

## G. Depth and the terminal rule

```ts
export const MAX_DRILL_DEPTH = 4;
```

**Fixed analytical depth of four.** Individual focus becomes available at
`path.length >= MAX_DRILL_DEPTH`, exactly as it does today — the constant equals
`DRILL_SEQUENCE.length`, so §14 behaviour is unchanged by construction.

Rejected: a **user-selected terminal "Leads" step** (a second kind of control,
and a second way to be at the bottom), and **depth-when-the-cluster-is-small**
(makes `isIndividualFocus` depend on the book, which is read *per frame* — focus
would flicker as the feed changes a child count, and a pure `(lead, path)`
predicate would become impure).

The three files that currently read `DRILL_SEQUENCE.length` for this —
`drillStore.ts`, `SelectedLeadFocus.tsx`, `CameraRig.tsx` — switch to
`MAX_DRILL_DEPTH`. Same value, explicit meaning, and the coupling to the default
sequence is severed.

**Not changed:** selection still works at any depth (clicking a particle or a
roster row). Only the §14 spatial *focus* treatment waits for full depth, as
today.

---

## H. Live-path validity

The book is live: agent ownership changes on every event, `timeframe` buckets
move with the wall clock, `temperature` follows `stage`. A path the user chose
five minutes ago can shrink or empty.

**Binding: history is never rewritten.** No auto-popping, no substituting a
different key, no "we moved you up a level". The path is what the user asked
for, and Apsis reports what is true about it.

| state | behaviour |
|---|---|
| members > 0 | normal |
| members shrink | normal; counts are live and already truthful |
| members = 0 | honest empty state: the breadcrumb stands, the child list is replaced by one line explaining the cluster is currently empty **and that the book is live**, and the existing Back control is the way out |
| a key no lead satisfies | identical to members = 0 — it is the same condition |

`LeadList` already renders `No leads in this cluster.` — that composes for free.
`isIndividualFocus` already requires membership, so focus dissolves on its own.

**Camera on an empty cluster:** `CameraRig` already handles `n === 0` by framing
the origin. That behaviour is **kept as-is for v1** and is not to be
re-engineered here; it reads as "nothing here", and changing camera behaviour is
out of scope for a milestone about a menu.

---

## I. Cluster computation

`clusterChildren(leads, path)` changes in exactly one way: the dimension it
groups by comes from the **selected** next dimension rather than
`DRILL_SEQUENCE[path.length]`.

```ts
export function nextDimension(
  path: readonly PathStep[],
  selectedId?: string | null,
): ClusterDimension | null;
```

- `selectedId` present and valid ⇒ that dimension.
- otherwise ⇒ `DRILL_SEQUENCE[path.length]` (today's behaviour).
- `path.length >= MAX_DRILL_DEPTH` ⇒ `null` (terminal), regardless.

An unknown or stale `selectedId` falls back to the default rather than throwing
or rendering nothing — a menu selection is not a place to fail hard.

---

## J. Camera

**No behavioural change, and this is a criterion rather than a hope.**
`CameraRig` frames `matchesPath(path)` members → centroid → spread. Because a
dynamic path is still a path, the same code produces the right framing for
`Campaign · Open Enrollment` with no knowledge that campaigns exist.

Forbidden: dimension-specific camera coordinates, per-dimension framing tweaks,
any notion of layout that depends on which dimension was chosen. The only
permitted edit to `CameraRig.tsx` is the `DRILL_SEQUENCE.length` →
`MAX_DRILL_DEPTH` constant swap (§G). Individual focus continues to arrive on
the lead's **live rendered position** read from the field buffer.

---

## K. LeadField

**No change at all.** `LeadField.tsx` is on the forbidden list.

Emphasis and recession already derive from `matchesPath`; a campaign cluster
dims exactly the way a city cluster does. Choosing `campaign`, `source`,
`agent`, `timeframe` or `temperature` must never regroup particles, and the way
to guarantee that is to not touch the file — if the implementation needs to,
the design is wrong.

Score remains the only cause of physical movement (§27 rule 3).

---

## L. LeadList composition

**No change.** `LeadList.tsx` is on the forbidden list.

It already filters `matchesPath(lead, path)` before the cap, then composes with
`matched` (command results), then `search`. A dynamic path enters through the
same door. What must remain true, and is covered by the existing suite:

- the header count stays truthful (`N in cluster` / `showing X of Y` /
  `N of M match` / `· command filtered`);
- command filtering and search still compose;
- hover stays bidirectional (and D25 still holds — nothing may resize on hover);
- at full depth every member is listed;
- the selected lead stays coherent, and selecting a cluster clears an
  incompatible selection exactly as today.

---

## M. Breadcrumbs

The problem is real: `Open Enrollment › Florida › Hot` does not say what those
are.

**Rule: show the dimension label only when the step diverges from the default
for its depth.**

```
default path   West › Colorado › Colorado Springs › Supplemental
dynamic path   Campaign · Open Enrollment › Florida › Temperature · Hot
                                            ^ state is the default at depth 1
```

This is the restrained answer: the default screen is untouched (§C), and the
dimension appears exactly where it is load-bearing. The `·` separator and a
muted micro-label reuse existing type styles; no new chrome.

**Accessibility is not conditional.** The accessible name of every crumb always
includes the dimension — `"Campaign: Open Enrollment"` — whether or not the
label is drawn. A screen reader user never has to infer it from position.

---

## N. Picker UI specification

The heading becomes a control:

```
Drill into  [ City ▾ ]   6          ← closed (default state)

Drill into  [ City ▾ ]   6          ← open
  ( City ) ( Segment ) ( Campaign ) ( Source ) ( Agent ) ( Timeframe )
  Tampa 84   Orlando 61   Miami 57   …
```

- **Trigger:** a `<button>` carrying the current dimension's label, with
  `aria-expanded` and `aria-controls`. It sits inside the existing `<h3>`, so no
  vertical space is added when closed.
- **List:** a `<ul>` of `<button>` chips, styled as outlined siblings of the
  existing filled child chips — visibly a different *kind* of choice. The active
  one carries `aria-current="true"`.
- **Choosing** sets `nextDimensionId`, closes the list, and re-renders the child
  chips below. **It does not navigate** — no step is pushed, no history changes.
- **Real DOM**, inside the existing `.uv-clusters` overlay, never the canvas
  subtree.

Forbidden by name: dropdowns with native `<select>` styling, filter bars, modal
configuration, permanent chrome, fake 3D controls, animation beyond the
existing chip transitions.

**The overlay stays visually subordinate to the field.** Closed, this milestone
adds one word and a caret.

---

## O. Responsive behaviour

The picker lives in the **stage overlay**, not the rail — so it cannot push rail
content below the fold and cannot reintroduce a D12/D21 reachability failure.
That is a property of where it is placed, and the placement is binding.

- The dimension row scrolls **within its own container** (`overflow-x: auto`),
  never the page. No horizontal overflow at any tested viewport.
- Verified at 1280×800, 1600×1000, 2560×1440 and 700×900 stacked — the sizes the
  suite already covers.
- **Nothing resizes on hover** (D25).
- Truncation is not permitted as the only access path: every dimension and every
  child must be reachable by real input (scroll or keyboard).

---

## P. Accessibility

| element | contract |
|---|---|
| trigger | `<button aria-expanded="false" aria-controls="uv-dim-list">`, accessible name `"Group next by City. 6 alternatives."` |
| list | `<ul id="uv-dim-list">` of `<button>`s; active has `aria-current="true"` |
| keyboard | Tab reaches the trigger; Enter/Space toggles; Tab moves through chips; Enter chooses |
| focus | opening moves focus to the active chip; choosing returns focus to the trigger |
| Escape | **closes the picker first**, then falls through to today's order |
| screen reader | crumbs always announce `"Campaign: Open Enrollment"` (§M); the child heading announces the current grouping |

**Escape ordering becomes:** open picker → selection → drill level. The existing
guard (never steal Escape from a text field or the listbox) is unchanged. This
is a change to a tested behaviour and gets its own test.

No new live region. `StatusAnnouncer` remains the only announcer.

---

## Q. Reduced motion

No new animation is introduced, so there is nothing new to suppress. The picker
opens and closes without transition under `prefers-reduced-motion`, matching the
existing chip behaviour. Camera damping is untouched.

---

## R. Persistence policy

**Do not persist. Reset to GLOBAL with default dimensions on every load.**

The reasoning, stated so it is not revisited by accident: Persistence v1 is a
canonical **event log** replayed through `ingest` (D23). A drill path is not an
event and not domain state — it is where the user happens to be looking. It also
ages badly in a way domain state does not: a restored `timeframe · Today` path
is empty by the next morning, so the first thing a returning user would see is
an empty cluster they did not choose.

Persisting it merely because a persistence layer exists is the failure mode this
policy prevents.

---

## S. Files allowed to change

- `src/universe/clusters.ts` — `MAX_DRILL_DEPTH`, `availableDimensions`,
  `nextDimension(path, selectedId?)`
- `src/state/drillStore.ts` — `nextDimensionId`, `chooseNextDimension`, the
  depth cap constant
- `src/universe/UniverseOverlay.tsx` — the picker, breadcrumb labelling, empty
  state, Escape ordering
- `src/universe/SelectedLeadFocus.tsx` — **constant swap only**
- `src/universe/CameraRig.tsx` — **constant swap only**
- `src/App.css` — additive rules for the picker
- new test files; `src/universe/dimensions.test.ts` may grow

## T. Files forbidden to change

`src/universe/LeadField.tsx` and `src/ui/LeadList.tsx` — **if either needs a
change, the design is wrong** (§K, §L) · `src/domain/**` · `src/state/store.ts`
and `persistence.ts` · `src/command/**` · `server/**` · `api/**` ·
`e2e/progressive-reveal.spec.ts` · `e2e/spatial-focus.spec.ts` ·
`e2e/reachability.spec.ts` · `e2e/persistence.spec.ts` · `e2e/auth.spec.ts` ·
`e2e/llm-command.spec.ts` · `e2e/host-boundary.spec.ts`.

No new dependency. No change to bloom, DPR, glass, the lead shader or
OrbitControls damping.

---

## U. Unit tests

1. **Default flow untouched** — with `nextDimensionId: null`, `nextDimension`
   returns region/state/city/segment at depths 0–3 and `null` at 4.
2. **Every registered dimension is reachable** — `availableDimensions` at GLOBAL
   offers all nine on the seeded book.
3. `campaign` partitions its parent exactly: child counts sum to the parent and
   every member lands in exactly one child.
4. `source` partitions exactly.
5. `agent` partitions exactly **and includes `Unassigned`** on a cold book.
6. `timeframe` partitions exactly, including the `older` catch-all.
7. `temperature` partitions exactly across all seven stages.
8. **No dimension drops a lead** — for every dimension, `Σ children = members`.
9. A dimension already determined by the path (repeat, or `region` after
   `state`) is **not offered**.
10. Choosing a next dimension **does not modify `path`**.
11. `push`/`pop`/`reset`/`toDepth` each clear `nextDimensionId`.
12. An unknown or stale `selectedId` falls back to the default.
13. `matchesPath` is correct for a mixed dynamic path
    (`campaign → state → temperature`).
14. `MAX_DRILL_DEPTH === DRILL_SEQUENCE.length`, so §14 is unchanged by
    construction; `push` refuses beyond it.
15. `isIndividualFocus` is true at depth 4 on any dimension mix, false at 3.
16. Empty cluster: `availableDimensions` returns `[]`, `clusterChildren` returns
    zero children and zero members, and nothing throws.
17. A single-child dimension is hidden, and drilling a one-member cluster still
    behaves.

## V. Browser tests

1. Default path drives `GLOBAL → West → Colorado → Colorado Springs →
   Supplemental` with the picker never opened, and the screen is visually
   unchanged (no dimension labels in crumbs).
2. A dynamic path — `Campaign → Open Enrollment → Temperature → Hot` — filters
   the field and the roster.
3. Breadcrumbs label divergent steps and not default ones; accessible names
   always carry the dimension.
4. **The field does not regroup**: particle positions before and after choosing
   a dimension are identical (sampled from the field buffer).
5. Camera frames the selected members — the same assertion shape §14 already
   uses, on a dynamic path.
6. Roster equals the dynamic cluster; count language stays truthful.
7. Command filtering composes with a dynamic path.
8. Search composes with a dynamic path.
9. Hover stays bidirectional on a dynamic path (one extra draw call, D25 holds).
10. Individual focus engages at depth 4 of a dynamic path; §14 card appears.
11. Escape order: picker → selection → drill level.
12. Every dimension chip and child chip is keyboard reachable and operable.
13. No horizontal overflow, and the rail is unaffected, at 1280×800, 1600×1000,
    2560×1440 and 700×900.
14. Empty cluster (drill to a `timeframe` bucket with no members) shows the
    honest empty state, keeps the breadcrumb, and backs out cleanly.
15. Persistence and replay unaffected; a reload returns to GLOBAL with defaults.

## W. Performance acceptance

- `availableDimensions` runs **on picker open only**, never per frame or per
  revision.
- No new per-frame React work; `useFrame` bodies unchanged.
- Draw calls unchanged (the field is untouched).
- The closed rendering investigation is not reopened: no change to bloom
  resolution, DPR, glass, the shader path or damping.
- A measurable regression is the only thing that may justify touching any of the
  above, and it must be measured on the owner's hardware, not asserted.

## X. Acceptance criteria

1. The default experience is unchanged — proven by `progressive-reveal`,
   `spatial-focus` and `reachability` passing **unmodified**.
2. All nine dimensions are reachable through the picker.
3. No dimension drops a lead; every partition sums to its parent.
4. `LeadField.tsx` and `LeadList.tsx` are unchanged.
5. `CameraRig.tsx` and `SelectedLeadFocus.tsx` differ by a constant swap only.
6. Score remains the only cause of lead movement, asserted from the field buffer.
7. Path history is never rewritten; an empty cluster is reported honestly.
8. `PathStep` is unchanged and no state is mirrored.
9. Escape order is picker → selection → drill.
10. Keyboard and screen-reader access hold at every tested viewport; no
    horizontal overflow; nothing resizes on hover.
11. Nothing persists; reload returns to GLOBAL with defaults.
12. Baselines grow, never shrink: **432 unit, 66 browser**. D36–D47, the host
    endpoint, the LLM validator and fallback, Arc A, Persistence v1, §14,
    progressive reveal, Round 7 and D35 all intact.

## Y. Implementation sequence

1. `clusters.ts`: `MAX_DRILL_DEPTH`, `nextDimension(path, selectedId?)`,
   `availableDimensions`. Unit tests U.1–9, 12–13, 16–17 first — this is pure
   domain-shaped code and belongs under test before any UI exists.
2. Constant swap in `drillStore.ts`, `SelectedLeadFocus.tsx`, `CameraRig.tsx`;
   U.14–15. Suite must still be green with no UI change yet.
3. `drillStore.ts`: `nextDimensionId` + `chooseNextDimension`, clearing on every
   navigation; U.10–11.
4. `UniverseOverlay.tsx`: wire `clusterChildren` to the selected dimension —
   **still no picker**. Default behaviour must be provably identical here.
5. The picker itself: trigger, list, focus management, Escape ordering.
6. Breadcrumb divergence labelling and accessible names.
7. The empty-cluster state.
8. `App.css` additive rules; responsive and overflow checks.
9. Browser tests V.1–15.
10. Full gates.

## Z. Recommended model split

**Opus for steps 1–7 and 9–10.** This is state, registry semantics, partition
correctness and accessibility — the visual delta is one word, a caret, and a row
of chips that reuse an existing idiom.

**Fable optionally for step 8 alone**, and only if the owner wants the picker's
open state to feel more cinematic than "outlined chips". Not required, and not
before the behaviour is green — the §14 pattern: correctness first, then an
optional visual pass with the tests already standing.

## AA. The next implementation prompt

> **APSIS — DYNAMIC DRILL DIMENSIONS — IMPLEMENTATION**
>
> MODEL: OPUS HIGH. Repo `niko587/Apsis`, branch `main`, checkpoint `<current>`.
>
> Read `docs/CONTRACT_DYNAMIC_DRILL_DIMENSIONS.md` and treat it as binding.
> Follow §Y in order — `clusters.ts` and its unit tests first, then the constant
> swap, then the store, and only then any UI.
>
> Make the nine registered §15 dimensions reachable by letting the user choose
> **the next grouping at each level**, with the existing default chain
> pre-selected at every depth.
>
> **The requirement that defines the milestone (§C):** a user who never opens
> the picker gets today's experience exactly — proven by
> `progressive-reveal.spec.ts`, `spatial-focus.spec.ts` and
> `reachability.spec.ts` passing **unmodified**.
>
> **The requirement that defines the architecture (§K, §L, §T):**
> `LeadField.tsx` and `LeadList.tsx` must not change. Emphasis, recession and
> the roster already derive from `matchesPath`, so a dynamic path enters through
> the existing door. If either file needs an edit, stop and re-read the
> contract. `CameraRig.tsx` and `SelectedLeadFocus.tsx` may change by a constant
> swap only.
>
> **The invariant that outranks the feature:** score is the only thing that
> moves a lead. Choosing `campaign`, `agent` or `temperature` must not regroup a
> single particle — assert it from the field buffer, not by inspection.
>
> **The honesty requirement (§H):** the book is live, so a path can empty.
> Never rewrite history, never auto-pop, never substitute a key. Report the
> empty cluster and leave the way out where it already is.
>
> Depth is `MAX_DRILL_DEPTH = 4` (§G) — explicit, no longer accidentally
> `DRILL_SEQUENCE.length`. Nothing persists (§R). Files allowed in §S, forbidden
> in §T. Meet every criterion in §X. Baselines grow, never shrink: 432 unit, 66
> browser.
>
> Do not reopen the rendering investigation, and do not begin any later
> milestone.
