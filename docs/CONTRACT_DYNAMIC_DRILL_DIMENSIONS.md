# Dynamic drill dimensions — architecture and interaction contract

_Written 2026-09-16 by Opus after inspecting the repository at `337afa2`;
revised at `b6ea480` after a correctness review found five internal
contradictions. Binding for the implementation phase. **Nothing here is
implemented yet.**_

_The revision withdrew three claims that were wrong: that all nine dimensions
are available at GLOBAL (`agent` is not — §F.1), that a null selection resolves
to the depth default (it must resolve past defaults that cannot split — §I), and
that the 150-row roster cap can never truncate a full-depth cluster (measured
maximum is **266** — §L)._

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
- No `availableDimensions` in state. It is derived in the overlay on the
  existing throttled cadence (§I) — it has to be, because the *effective* next
  dimension depends on it even when the picker has never been opened. Putting a
  derived value in a store would mean two things that can disagree.
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

A dimension is offered when it **can split the current cluster into more than
one child**, and hidden otherwise.

```ts
export function availableDimensions(
  leads: Iterable<Lead>,
  path: readonly PathStep[],
): ClusterDimension[];
```

One rule, not three, and it subsumes every case the brief asks about:

| case | outcome | why |
|---|---|---|
| dimension already used in this path | hidden | every member shares that key, so it yields one child |
| `region` after `state`, `state` after `city` | hidden | geography is nested, so the coarser dimension is already determined. **No special-casing is needed**, and none is added |
| `city` after `region` | offered | genuinely splits |
| every member happens to share a value | hidden | a control that provably changes nothing is noise |
| ≥2 distinct values | offered | |
| cluster is empty | none offered | §H governs the screen |

**Repeats are therefore impossible** without a special rule, because a repeated
dimension always yields one child.

**Ordering:** default-for-this-depth first, then registry order
(`region, state, city, segment, campaign, source, agent, timeframe,
temperature`). Never by child count — a list that reorders itself as the feed
lands is a list nobody can build muscle memory for.

### F.1 Agent is not available on a fresh book, and that is correct

Every seeded lead begins with `ownerAgentId: null` (`seed.ts`), so on an
untouched book the `agent` dimension has exactly **one** child, `Unassigned`.
Under rule A it is therefore **not offered**, and it becomes offered on its own
once real events have created a second ownership bucket inside the current
cluster — `ingest` sets `ownerAgentId` from the event's `agentId`.

An earlier draft of this contract asserted both "offered only when it splits"
and "all nine are available at GLOBAL on the seeded book". **Those cannot both
be true.** Rule A is kept; the claim is withdrawn.

**Forbidden fixes:** seeding fake agent assignments so a menu test passes, and
special-casing `agent` to appear anyway. Either would make the UI claim a
partition the data does not have.

The acceptance criterion is restated as: **every registered dimension becomes
selectable whenever it can meaningfully partition the current cluster** — and
`agent` is tested against a focused fixture carrying two ownership keys, or
against a book after real events, never against a fabricated seed.

### F.2 Iterable safety: exactly one traversal

Production calls this with `leads.values()` — a **Map iterator, which is
single-pass**. An implementation shaped as

```ts
for (const dim of DIMENSIONS) for (const lead of leads)   // FORBIDDEN
```

would let only the first dimension see the book and silently report every other
dimension as unavailable. The bug would look like "the picker only ever offers
region".

**Required shape — one pass over the iterable, all dimensions advanced
together:**

```
seen: Map<dimensionId, Set<string>>   // at most 2 keys retained per dimension
proven: Set<dimensionId>              // has ≥2 distinct keys; stop storing

for (const lead of leads) {
  if (!matchesPath(lead, path)) continue
  members++
  for (const id of candidates) {
    if (proven.has(id)) continue
    const key = DIMENSIONS[id].keyFor(lead)
    if (key === null) continue
    const keys = seen.get(id)
    if (keys.has(key)) continue
    keys.add(key)
    if (keys.size >= 2) { proven.add(id); seen.delete(id) }
  }
}
```

Complexity **O(members × registered dimensions)** with **at most two retained
strings per dimension**. A unit test passes a deliberately one-shot iterator (a
generator) and asserts every eligible dimension is still discovered — a
multi-pass implementation fails it immediately.

## G. Depth and the terminal rule

```ts
export const MAX_DRILL_DEPTH = 4;
```

**Fixed analytical depth of four.** Individual focus becomes available at
`path.length >= MAX_DRILL_DEPTH`.

Rejected: a **user-selected terminal "Leads" step** (a second kind of control,
and a second way to be at the bottom), and **depth-when-the-cluster-is-small**
(makes `isIndividualFocus` depend on the book, which is read *per frame* — focus
would flicker as the feed changed a child count, and a pure `(lead, path)`
predicate would become impure).

The three files that currently read `DRILL_SEQUENCE.length` for this —
`drillStore.ts`, `SelectedLeadFocus.tsx`, `CameraRig.tsx` — switch to
`MAX_DRILL_DEPTH`.

### G.1 Do not re-couple depth to the default chain

An earlier draft specified a test asserting
`MAX_DRILL_DEPTH === DRILL_SEQUENCE.length`. **That is withdrawn**: it would
re-tie the two concepts this section just separated, and it would mean that
shortening or extending the default *suggestion* chain silently redefined what
"analytical depth" means — a change to a convenience list quietly changing when
§14 focus engages.

The two facts are tested **independently**:

- `MAX_DRILL_DEPTH` is `4`;
- the current default chain has four entries and is
  `region → state → city → segment`;
- focus activates at `MAX_DRILL_DEPTH` on any dimension mix;
- `push` refuses beyond `MAX_DRILL_DEPTH`.

They happen to agree today. Nothing may assert that they must.

**Not changed:** selection still works at any depth (clicking a particle or a
roster row). Only the §14 spatial *focus* treatment waits for full depth.

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

## I. Cluster computation and the effective dimension

**There is exactly one function that decides what the next grouping is**, and
the heading, the picker's active state and `clusterChildren` all read it. A
previous draft resolved `nextDimensionId === null` to
`DRILL_SEQUENCE[path.length]` directly, which breaks in two ordinary cases:

- `Agent → Timeframe → Segment → push` leaves depth 3, whose raw default is
  `segment` — **already used**, so it yields one child;
- `City` at depth 0 leaves depth 1, whose raw default is `state` — **already
  determined by the city**, so it yields one child.

Both would violate §F while the heading cheerfully announced the dimension.

```ts
export function effectiveNextDimension(
  leads: Iterable<Lead>,
  path: readonly PathStep[],
  selectedId: string | null,
): { dimension: ClusterDimension | null; available: ClusterDimension[] };
```

Resolution order, and this is the only place it is written down:

1. `path.length >= MAX_DRILL_DEPTH` ⇒ `null` (terminal).
2. `available = availableDimensions(leads, path)` (§F). Empty ⇒ `null`.
3. `selectedId` is still in `available` ⇒ use it.
4. otherwise `DRILL_SEQUENCE[path.length]` is in `available` ⇒ use that.
5. otherwise the **first entry of `available`** in stable registry order.

Returning `available` alongside the choice is deliberate: the picker needs the
same list the resolution used, and computing it twice is how the heading and the
menu come to disagree.

**Resolving the next grouping is not rewriting history.** Steps 3–5 choose what
to offer; `path` is untouched. A `selectedId` that has stopped being available
is *superseded for this level*, not deleted — the next navigation clears it
anyway (§D).

`clusterChildren` groups by whatever `effectiveNextDimension` returned. It never
re-derives the dimension itself.

**Cost.** Two bounded passes per path change on the overlay's existing throttled
cadence: one for availability (early-exit, §F.2), one to count children of the
resolved dimension. Neither runs per frame.

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

## L. LeadList composition, and the measured truth about the 150-row cap

**No change. `LeadList.tsx` stays forbidden** — but for a *measured* reason, and
the old guarantee is withdrawn.

### L.1 The audit, and what it refuted

Progressive reveal recorded that a full-depth cluster "holds a median of 5
members and never more than 81, so `VISIBLE_CAP` can never truncate one". That
was a measurement of the **fixed** default sequence. Dynamic paths invalidate it,
so the question was re-measured rather than assumed.

Every reachable four-step path on the deterministic 4,892-lead book was
enumerated under the §F availability rules (branches that could not exceed the
cap were pruned):

| measure | result |
|---|---|
| **maximum terminal cluster** | **266 leads** |
| **path producing it** | `Region · Northeast → State · New York → City · New York, NY → Temperature · Cold` |
| terminals over 150 (fresh book) | **28** |
| next largest | 203 (`… → Timeframe · Last 30 days`), 167, 159 |
| with agent ownership present | maximum **unchanged at 266**; 32 terminals over 150 |

Ownership does not raise the maximum, which is the expected result: `agent` only
adds *narrower* paths.

**So the old guarantee is false for dynamic paths, and this contract does not
repeat it.** 266 > 150: a user drilling to cold New York City leads sees 150 of
them in the roster.

### L.2 The smallest truthful resolution

The cap is kept, and "fully accessible" is redefined against the mechanism that
actually exists:

1. **The roster never overstates.** The header already reads
   `showing 150 of 266 · narrow the drill or search` whenever the cap bites.
   That language was built for exactly this and is not to be weakened.
2. **In-cluster search is the reachability mechanism, and it works.** Verified
   in `LeadList.tsx`: the search needle is applied **before** the cap, so a
   member ranked 200th by score is surfaced by typing their name. Nothing is
   unreachable; it is one keystroke away and the header says so.
3. **The drill itself narrows.** A 266-member terminal exists only because the
   user chose four coarse dimensions; a fifth would not be available anyway at
   `MAX_DRILL_DEPTH`.

Rejected alternatives, with reasons:

- **Raising the cap to 300.** Covers this book and this seed, and nothing else.
  A `?leads=60000` diagnostic run would truncate again, so it buys a number, not
  a guarantee.
- **Lifting the cap at terminal depth.** Scales with the book: ~266 rows here,
  ~3,200 at 60k leads. Trading a truthful label for a DOM problem.
- **Adding virtualisation.** A dependency and a new rendering path, to solve a
  case the existing search already solves.

### L.3 What must be tested

- A **regression test pinning the measured maximum**: it recomputes the largest
  reachable four-step terminal on the seeded book and fails if it moves. It does
  *not* assert `≤ 150` — that would be asserting something known to be false.
  Its job is to make a change in the book, the dimensions or the rules
  re-open this decision instead of drifting past it.
- A **browser test proving reachability**: drill to a >150 terminal, confirm the
  header says `showing 150 of N`, then search for a member outside the visible
  150 and select them.

Everything the existing suite already guarantees still holds unchanged: counts
stay truthful, command filtering and search compose, hover stays bidirectional
(D25), and selecting a cluster clears an incompatible selection.

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
  vertical space is added when closed. Its accessible name is simply
  **"Group next by City"** — see §P.
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
| trigger | `<button aria-expanded="false" aria-controls="uv-dim-list">`, accessible name `"Group next by City"` — **no count** |
| list | `<ul id="uv-dim-list">` of `<button>`s; active has `aria-current="true"` |
| keyboard | Tab reaches the trigger; Enter/Space toggles; Tab moves through chips; Enter chooses |
| focus | opening moves focus to the active chip; choosing returns focus to the trigger |
| Escape | **closes the picker first**, then falls through to today's order |
| screen reader | crumbs always announce `"Campaign: Open Enrollment"` (§M); the child heading announces the current grouping |

**Why the name carries no count.** An earlier draft announced
`"Group next by City. 6 alternatives."`, which would require the availability
analysis to be live purely to voice a number that changes as the feed lands.
Once the picker is open the list itself makes the alternatives discoverable —
and it is a real list of real buttons, which is a better answer than a spoken
tally. (§I does compute availability on the throttled cadence, but for
correctness of the *effective dimension*, not to narrate.)

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

1. **Default flow untouched** — with `nextDimensionId: null` on a fresh book,
   the effective dimension is region/state/city/segment at depths 0–3 and `null`
   at 4.
2. **Selectability, stated correctly** — every registered dimension becomes
   selectable whenever it can meaningfully partition the current cluster. On a
   fresh book at GLOBAL that is **eight** dimensions; `agent` is absent because
   every lead is `Unassigned` (§F.1).
3. **`agent` becomes available once ownership exists** — tested against a
   focused fixture carrying two ownership keys (or a book after real events).
   **Not** by seeding fake assignments and **not** by special-casing `agent`.
4. `campaign` partitions its parent exactly: child counts sum to the parent.
5. `source` partitions exactly.
6. `agent` partitions exactly **and includes `Unassigned`** as a real bucket.
7. `timeframe` partitions exactly, including the `older` catch-all.
8. `temperature` partitions exactly across all seven stages.
9. **No dimension drops a lead** — for every dimension, `Σ children = members`.
10. A dimension already determined by the path (repeat, or `region` after
    `state`) is **not offered**.

**Effective-dimension resolution (§I)** — each of these failed the earlier draft:

11. A depth default that is **already used** (`Agent → Timeframe → Segment →`
    push, whose raw depth-3 default is `segment`) resolves to the first
    available dimension instead.
12. `City` at depth 0 → depth 1, whose raw default `state` is already determined,
    resolves past it.
13. A dynamic sequence where the depth default cannot split resolves to the
    first available in registry order.
14. A `selectedId` that has **stopped being available** falls back to the
    default, then to the first available — and `path` is untouched.
15. **No dimensions available** ⇒ `null`, and the overlay shows the terminal
    state rather than an empty grouping.
16. The heading, the picker's active state and `clusterChildren` all read the
    **same** resolved dimension — asserted by comparing them, not by inspection.

**Iterable safety (§F.2)**

17. `availableDimensions` is given a **one-shot generator** and still discovers
    every eligible dimension. A multi-pass implementation fails here.
18. Per-dimension key storage never exceeds two entries (asserted via a
    probe-counting fixture or by bounding allocations).

**Depth, decoupled (§G.1)**

19. `MAX_DRILL_DEPTH` is `4`.
20. The current default chain has four entries and is
    `region → state → city → segment`.
21. Focus activates at `MAX_DRILL_DEPTH` on **any** dimension mix, and not at
    depth 3. `push` refuses beyond `MAX_DRILL_DEPTH`.
    **There is no test asserting `MAX_DRILL_DEPTH === DRILL_SEQUENCE.length`.**

**Store and path**

22. Choosing a next dimension **does not modify `path`**.
23. `push`/`pop`/`reset`/`toDepth` each clear `nextDimensionId`.
24. `matchesPath` is correct for a mixed dynamic path
    (`campaign → state → temperature`).
25. Empty cluster: `availableDimensions` returns `[]`, `clusterChildren` returns
    zero children and zero members, nothing throws.

**The measured cap (§L.3)**

26. **Terminal-size regression**: recompute the largest reachable four-step
    terminal on the seeded book and assert it equals the recorded **266** via
    `Region · Northeast → State · New York → City · New York, NY →
    Temperature · Cold`. It does **not** assert `≤ 150`. Its job is to force a
    re-read of §L if the book, the dimensions or the rules change.

## V. Browser tests

1. Default path drives `GLOBAL → West → Colorado → Colorado Springs →
   Supplemental` with the picker never opened, and no dimension labels in crumbs.
2. A dynamic path — `Campaign → Open Enrollment → Temperature → Hot` — filters
   the field and the roster.
3. Breadcrumbs label divergent steps and not default ones; accessible names
   always carry the dimension.
4. **The field does not regroup**: particle positions sampled from the field
   buffer before and after choosing a dimension are identical.
5. Camera frames the selected members on a dynamic path.
6. Roster equals the dynamic cluster; count language stays truthful.
7. **The >150 terminal is honest and reachable** — drill
   `Region · Northeast → State · New York → City · New York, NY →
   Temperature · Cold`, assert the header reads `showing 150 of 266`, then
   search for a member outside the visible 150 and select them (§L.3).
8. Command filtering composes with a dynamic path.
9. Search composes with a dynamic path.
10. Hover stays bidirectional on a dynamic path (one extra draw call, D25 holds).
11. Individual focus engages at depth 4 of a dynamic path; the §14 card appears.
12. Escape order: picker → selection → drill level.
13. Every dimension chip and child chip is keyboard reachable and operable;
    focus enters the active option and returns to the trigger.
14. No horizontal overflow, and the rail is unaffected, at 1280×800, 1600×1000,
    2560×1440 and 700×900.
15. Empty cluster shows the honest empty state, keeps the breadcrumb, and backs
    out cleanly.
16. Persistence and replay unaffected; a reload returns to GLOBAL with defaults.

## W. Performance acceptance

- `availableDimensions` runs on the overlay's **existing throttled cadence**
  (the 1s `useThrottledRevision` that already drives `clusterChildren`) and
  **never per frame**. It cannot be deferred to picker-open, because §I needs it
  to resolve the effective dimension even when the picker has never been
  touched — an earlier draft claimed otherwise and was wrong.
- Two bounded passes per path change: availability (single traversal,
  early-exit at the second distinct key per dimension) and child counts for the
  resolved dimension. Both in DOM land, both already the shape of work the
  overlay does today.
- No new per-frame React work; `useFrame` bodies unchanged.
- Draw calls unchanged (the field is untouched).
- The closed rendering investigation is not reopened: no change to bloom
  resolution, DPR, glass, the shader path or damping.
- A measurable regression is the only thing that may justify touching any of the
  above, and it must be measured on the owner's hardware, not asserted.

## X. Acceptance criteria

1. The default experience is unchanged — proven by `progressive-reveal`,
   `spatial-focus` and `reachability` passing **unmodified**.
2. Every registered dimension becomes selectable whenever it can meaningfully
   partition the current cluster — `agent` included, once ownership exists, and
   without fabricated seed data or a special case.
3. No dimension drops a lead; every partition sums to its parent.
4. `LeadField.tsx` and `LeadList.tsx` are unchanged, the latter on the evidence
   in §L rather than on the withdrawn 81-member assumption.
4b. The roster never overstates a >150 terminal, and every member of one is
   reachable through in-cluster search — asserted in the browser.
4c. One function resolves the effective next dimension, and the heading, the
   picker and `clusterChildren` demonstrably agree.
4d. `availableDimensions` traverses its iterable exactly once.
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

1. `clusters.ts`: `MAX_DRILL_DEPTH`, `availableDimensions` (single traversal,
   §F.2), `effectiveNextDimension` (§I). Unit tests U.1–18 and 24–26 first —
   this is pure domain-shaped code and belongs under test before any UI exists.
   **Write U.17 (one-shot iterator) early**: it is the test that catches the
   dimension-outer/lead-inner shape before it is built on.
2. Constant swap in `drillStore.ts`, `SelectedLeadFocus.tsx`, `CameraRig.tsx`;
   U.19–21. Suite must still be green with no UI change yet.
3. `drillStore.ts`: `nextDimensionId` + `chooseNextDimension`, clearing on every
   navigation; U.22–23.
4. `UniverseOverlay.tsx`: route the heading and `clusterChildren` through
   `effectiveNextDimension` — **still no picker**. Default behaviour must be
   provably identical here, and U.16 (heading, picker, children agree) is
   meaningful from this step onward.
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
> Make the registered §15 dimensions reachable by letting the user choose **the
> next grouping at each level**, with the existing default chain pre-selected at
> every depth.
>
> **The requirement that defines the milestone (§C):** a user who never opens
> the picker gets today's experience exactly — proven by
> `progressive-reveal.spec.ts`, `spatial-focus.spec.ts` and
> `reachability.spec.ts` passing **unmodified**.
>
> **One function decides the next grouping (§I).** `effectiveNextDimension`
> resolves terminal → available → selected → depth default → first available,
> and the heading, the picker's active state and `clusterChildren` all read it.
> Resolving past a default that cannot split is not rewriting history; `path` is
> untouched.
>
> **`availableDimensions` traverses its iterable EXACTLY ONCE (§F.2).**
> Production passes `leads.values()`, a single-pass Map iterator, so a
> dimension-outer/lead-inner loop would silently report every dimension after
> the first as unavailable. Write the one-shot-generator test early.
>
> **`agent` is not available on a fresh book, and that is correct (§F.1).**
> Every seeded lead is `ownerAgentId: null`, so it has one child. Do not seed
> fake assignments and do not special-case it — test it against a fixture with
> two ownership keys.
>
> **The 150-row cap was re-measured and the old guarantee is withdrawn (§L).**
> The largest reachable four-step terminal on the seeded book is **266**
> (`Region · Northeast → State · New York → City · New York, NY →
> Temperature · Cold`), with 28 terminals over 150. `LeadList.tsx` stays
> forbidden because search is applied *before* the cap, so every member is
> reachable by name — prove that in the browser, and do not weaken the
> `showing X of Y` language.
>
> **The invariant that outranks the feature:** score is the only thing that
> moves a lead. Choosing `campaign`, `agent` or `temperature` must not regroup a
> single particle — assert it from the field buffer, not by inspection.
> `LeadField.tsx` must not change; if it needs to, stop and re-read the
> contract.
>
> **The honesty requirement (§H):** a standing path can empty as the book moves.
> Never auto-pop, never substitute a key. Report it and leave the way out where
> it already is.
>
> Depth is `MAX_DRILL_DEPTH = 4` (§G) — and **do not add a test asserting it
> equals `DRILL_SEQUENCE.length`**, which would re-couple what §G separates.
> Nothing persists (§R). Files allowed in §S, forbidden in §T. Meet every
> criterion in §X. Baselines grow, never shrink: 432 unit, 66 browser.
>
> Do not reopen the rendering investigation, and do not begin any later
> milestone.
