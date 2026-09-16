# §14 Spatial Individual Transition — implementation contract

_Written 2026-09-16 by Opus for Fable. This is the contract, not the design.
Fable owns how it looks; this document owns what must remain true._

## A. What already exists

**More than the roadmap implies.** `CameraRig` already performs a partial §14:

```ts
// CameraRig.tsx — at full drill depth, a selection pulls the framing
// partway onto that lead's LIVE position.
if (selectedId && focus.depth >= DRILL_SEQUENCE.length && field) {
  s.lead.set(field.positions[idx*3], …).applyQuaternion(field.quaternion);
  s.desiredT.lerp(s.lead, 0.45);   // ← 45%, and no dolly-in
}
```

So the camera *leans* toward the selected lead but never arrives, and nothing in
the scene marks the lead as the subject. `LeadField` draws a billboarded
selection ring (`markerRef`, `depthTest: false`, sinusoidal scale pulse) —
correct but tiny and easily lost in a dense rim. The remaining gap is exactly
what `SELF-CRITIQUE.md` says it is: *"the individual level still resolves into
the rail panel rather than into the field… a presentation miss rather than a
navigation one."*

Mechanisms already in place that the implementation must use rather than
reinvent:

| concern | existing mechanism |
|---|---|
| live lead position | `readField().positions[idx*3..]` in field-LOCAL space, then `.applyQuaternion(field.quaternion)` |
| index lookup | `readIndexOf().get(leadId)` — O(1), already maintained |
| drill path | `readDrillPath()`, immutable array, reference-compared per frame |
| selection | `useApsis.getState().selectedLeadId` |
| dimming | `lit = 0.13` written into `colors[]` inside LeadField's revision-gated walk |
| reduced motion | `useReducedMotion()` (already ORs in `?anim=off`) |
| DOM over canvas | `UniverseOverlay` portals real DOM into `.stage`, `z-index: 3` |
| a11y announce | `SelectionAnnouncer`, `role="status" aria-live="assertive"` |

## B. State contract — add nothing

**Do not introduce `focusedLeadId`, `isFocused`, or any new store.** The state
already exists and is unambiguous:

```ts
const atFullDepth = readDrillPath().length >= DRILL_SEQUENCE.length;  // 4
const selectedId  = useApsis.getState().selectedLeadId;

// TIER 2 — individual focus: the full spatial resolve.
const individualFocus = selectedId !== null && atFullDepth;

// TIER 1 — selection anywhere else: emphasis only, camera untouched.
const selectedOnly    = selectedId !== null && !atFullDepth;
```

**Two tiers, deliberately.** A user who clicks a row in the Leads list from
GLOBAL has not asked to be flown somewhere; hijacking the camera there would
make the list unusable. That is why the existing rig gates on `focus.depth >=
DRILL_SEQUENCE.length`, and that gate stays.

`selectedLeadId` is set from three places already — the field's `onClick`, the
Leads listbox, and `onPointerMissed` clearing it. All three must keep working
unchanged.

## C. Camera contract

**The lead's position is authoritative and is never moved.** Score is the only
thing that moves a lead (D1). The camera goes to the lead; the lead does not
come to the camera.

1. **Read the rendered position, not the target orbit.** Use
   `field.positions[idx*3..]`, not `positionFor(lead)`. The former is where the
   sprite actually is this frame; the latter is where it is heading, and during
   travel they differ. `LeadField`'s marker block already documents this trap.
2. **Apply the field quaternion.** The buffer is field-LOCAL and the field spins
   at `delta * 0.018`. A camera target that skips the quaternion will drift off
   the lead continuously.
3. **Target:** at individual focus, lerp `desiredT` to **≥ 0.85** of the lead
   position (today it is 0.45). Going to a full 1.0 is permitted.
4. **Distance:** keep the existing clamp discipline —
   `MIN_DIST = APOAPSIS * 0.36`, `MAX_DIST = APOAPSIS * 1.4`. **`MIN_DIST` must
   remain ≥ `OrbitControls.minDistance` (`APOAPSIS * 0.35`)** or the controls'
   own clamp snaps the camera the frame after the rig places it — the code
   already carries that warning. If you want closer than `APOAPSIS * 0.36`, you
   must lower `OrbitControls.minDistance` too, and that changes what the user can
   zoom to. **Raise that as a decision; do not do it silently.**
5. **Preserve the user's azimuth.** The rig derives spherical coords from the
   *current* camera offset and only overrides radius and phi. Keep that: yanking
   azimuth makes the move feel like a cut rather than an approach.
6. **Timing:** the existing exponential approach, `k = 1 - exp(-rate * delta)`,
   frame-rate independent. `rate = reducedMotion ? 24 : 3.1`. A different rate
   for the individual leg is fine; a `setTimeout`/tween/timeline is not (§27.3 —
   nothing may own the camera between frames).
7. **Handoff:** `settling.current` gates camera *position*; once within
   `0.004` squared units the rig stops driving position and the user owns the
   camera again, while `controls.target` keeps tracking. Entering **and leaving**
   individual focus must set `settling = true` so the move animates in both
   directions.

## D. Selected-lead visual contract

**May change, for the selected lead only:**

- the existing marker ring — scale, colour, opacity, a second concentric ring
- **one** additional scene object (sprite, shader quad, small point cloud)
- emissive/brightness of that lead's own sprite
- a halo or soft pulse, provided it respects reduced motion

**Must not change, ever:**

- `current[]` / rendered position — the lead does not move, grow a leash, or
  detach from its orbit
- `score`, `stage`, `gravity`, `theta`, `inclination`, or anything in the store
- the one-draw-call structure of the field itself

**Cost rule: one effect for one lead, never 4,892 cheap ones.** Note a specific
trap: writing `aSize[selectedIndex]` per frame requires
`geometry.getAttribute('aSize').needsUpdate = true`, which re-uploads the
**whole** attribute — 19 KB per frame at the default book, 240 KB at 60k. If the
emphasis needs per-frame animation, put it on a separate object rather than in
the shared buffer. A one-off write inside the existing revision-gated walk is
fine.

## E. Surrounding field contract

Permitted: reuse the **existing** `lit = 0.13` dim, a depth or contrast
emphasis, de-emphasis of immediate neighbours.

Forbidden: a second per-frame pass over the whole book (the revision-gated walk
is the only place the book may be walked for colour); dimming below the existing
`0.13` floor; hiding the Universe. **The point of §15's "recede, don't remove"
is that the shape of the whole book stays legible — that survives here.**

## F. In-scene information contract

Minimum: **name**, **stage label**, **score**. Permitted beyond that:
`segment`, `location`, `campaign`, `acquisitionSource`, owning agent label, and
`nextBestAction(lead, Date.now(), claimed.has(id)).label`.

All authoritative and already on the lead — **no fabricated fields, no invented
copy.** If a value is absent (`ownerAgentId` is `null` on an unworked lead),
show nothing or "Unassigned", never a guess.

Implementation rules:

- **Real DOM portalled into `.stage`**, following `UniverseOverlay`. Not canvas
  text: it must stay crisp at DPR 2 and selectable.
- **No `backdrop-filter`.** That was the round-7 bottleneck; the shipping glass
  pattern is a gradient + inset rim + drop shadow (see `.command-row`).
- `pointer-events: none` unless it carries a control; if it does, it must not sit
  over `.command`.
- It is *confirmation*, not a dashboard. If it needs a scrollbar, it is too big.

## G. Rail relationship

`LeadDetail` stays exactly as it is — complete, and still carrying every §14
field. The in-scene element is primary *spatial* confirmation; the rail remains
the detail surface. **Do not delete, shrink or restructure the rail panel.**
Reducing it to a stub would re-open D12 (`rendered ≠ reachable`) from the other
direction.

## H. Reduced motion contract

`useReducedMotion()` is live-subscribed and already folds in `?anim=off`.

- The camera still **arrives** — only the glide shortens (`rate 24`). The
  destination is information; the travel is not.
- Pulses, orbiting particles and shimmer become **static**, not absent: the
  emphasis must still read as emphasis.
- The in-scene card appears without a transition.
- Nothing that conveys information may be removed. This mirrors the existing
  rule in `useReducedMotion`'s own doc comment.

## I. Accessibility contract

- `SelectionAnnouncer` keeps announcing selection. Do not move or duplicate it.
- **The in-scene card must be `aria-hidden="true"`.** It restates what the
  announcer and the rail already expose; leaving it in the tree double-announces
  every selection.
- The canvas stays `aria-hidden`; the card is portalled into `.stage`, which is
  *outside* that wrapper, so `aria-hidden` must be set explicitly.
- **Escape order is fixed** (`UniverseOverlay`): selection first, then one drill
  level per press, and Escape is never stolen from an input or the listbox.
- Keyboard camera (`CameraKeys`, arrows/±) must keep working during focus.
- The Leads listbox remains a complete path to every lead. The in-scene element
  must never be the only way to reach detail.

## J. Responsive rules

| viewport | constraint |
|---|---|
| ≥1600 desktop / ultrawide | card must track the lead, not park in a screen corner; never wider than ~320 px |
| 1100–1600 laptop | `.command` is up to 760 px wide at `bottom: 20px` — the card must not overlap it |
| ≤1100 | `.canvas-hint` is hidden, `.command` becomes `calc(100% - 60px)` |
| ≤820 stacked | `.stage` is **`46vh`** with the rail beneath — the card must stay inside the stage box and must not overflow it |
| DPR 2 | DOM text only; no canvas-rendered glyphs |

The card must clamp to the stage bounds. A card that follows a lead to the edge
and gets clipped is the same class of defect as D12.

## K. Exit / unwind

| trigger | required behaviour |
|---|---|
| Escape (1st press) | clears selection → emphasis and card unwind, camera stops tracking the lead and relaxes to the cluster framing |
| Escape (2nd press) | pops one drill level (existing) |
| breadcrumb / `toDepth` | path changes → `computeFocus` reruns, `settling = true`, camera re-frames |
| different lead selected | camera **retargets**, emphasis moves; no full unwind, no flash through GLOBAL |
| cluster selected | same as breadcrumb |
| drill reset | `path = []` → depth 0 → after settling the rig goes inert and the user owns the camera |
| lead leaves the drilled set (its score moved it) | must not strand the camera; fall back to the cluster framing |

Anything created on entry must be disposed on exit — no orphaned geometry,
materials or listeners. `LeadField`'s existing `useMemo`/`useEffect` disposal
pattern is the reference.

## L. Files Fable may edit

- `src/universe/CameraRig.tsx` — the individual-focus leg
- `src/universe/LeadField.tsx` — **selection-marker block only**
- `src/universe/Universe.tsx` — to mount one new component
- **new** `src/universe/SelectedLeadFocus.tsx` (or similar) — the in-scene element
- `src/universe/overlay.css`, or a new stylesheet
- `src/App.css` — **additive rules only**, no edits to `.rail`, `.command`,
  `.panel` or anything in the round-7 glass treatment

## M. Files Fable must not touch

`src/state/**` (store, drillStore, persistence, boot, replay, source, sources) ·
`src/domain/**` (scoring, gravity, seed, agents, appointments, query,
nextAction, types) · `src/universe/Core.tsx` · `src/universe/clusters.ts` ·
`src/orchestrator/**` · `src/ui/LeadDetail.tsx` and the rest of the rail ·
`e2e/**` except to add a new spec · `.github/**` · `package.json` ·
the `<Bloom>` / `<EffectComposer>` configuration in `Universe.tsx`.

## N. Acceptance criteria

1. **Continuity** — GLOBAL → region → state → city → segment → lead reads as one
   move. No cut, no camera teleport, no flash through the origin.
2. **Camera** — target lands on the lead's *live* position and tracks it as the
   field rotates; azimuth preserved; distance inside the clamps; control returns
   to the user on settle.
3. **Selection fidelity** — the emphasised lead is the one in
   `selectedLeadId`, the rail panel and the listbox `aria-selected`. All four
   agree at all times.
4. **Position integrity** — the lead's rendered position is bit-identical with
   and without focus. Assert it.
5. **Back navigation** — every row of §K behaves as specified; two Escapes from
   focus land at the parent cluster with the camera settled.
6. **Reduced motion** — with `prefers-reduced-motion` (or `?anim=off`) the camera
   still arrives, the card still appears, nothing animates.
7. **A11y** — selection still announced exactly once; card is `aria-hidden`;
   Escape order unchanged; keyboard camera still works; the listbox still reaches
   every lead.
8. **Responsive** — at 1280×800, 1600×1000, 2560×1440 and a ≤820 stacked layout
   the card stays inside `.stage` and never overlaps `.command`. Add a Playwright
   case; the existing reachability suite is the pattern.
9. **Performance** — round-7 baseline preserved. No `backdrop-filter`, no new
   full-screen pass, no per-lead React components, no per-frame allocation, and
   **at most +2 draw calls**. Re-run `?matrix=1` on the M1 and compare p99 and
   `>33ms` counts against the round-6 table before claiming no regression.
10. **Gates** — `tsc`, `oxlint`, 156+ unit, build, 11+ browser tests green.

## O. The prompt for Fable

> **APSIS — §14 SPATIAL INDIVIDUAL TRANSITION — IMPLEMENTATION**
>
> MODEL: FABLE. Repository `niko587/Apsis`, branch `main`, checkpoint
> `8943262`.
>
> Read `docs/CONTRACT_14_SPATIAL_INDIVIDUAL.md` first and treat it as binding.
> Opus wrote it after inspecting the code; where it constrains you, the
> constraint is load-bearing and has a reason recorded next to it.
>
> **Build:** when the user reaches an individual lead at full drill depth, the
> Universe should resolve that lead spatially — the camera completing its
> approach onto the lead's live position, the lead becoming unmistakably the
> subject of the frame, and a small in-scene element carrying its name, stage
> and score. The rail keeps every detail; this is the spatial confirmation the
> journey currently lacks.
>
> **You own** the aesthetics: how the emphasis reads, how the field responds,
> how the card looks and moves, the choreography of the approach. Make it feel
> like arriving somewhere.
>
> **You do not own** the state model (§B — add none), the lead's position
> (§C — it never moves), the rail (§G — untouched), reduced motion (§H —
> shorten, never remove), the a11y contract (§I), or the round-7 performance
> baseline (§K: no `backdrop-filter` over the canvas, no new full-screen pass,
> at most +2 draw calls, zero per-frame allocation).
>
> Files you may edit are listed in §L; files you must not touch in §M. Meet
> every acceptance criterion in §N, run all gates, and re-run `?matrix=1` on the
> owner's M1 before claiming no performance regression.
>
> Do not change scoring, gravity, persistence, the source architecture or the
> command system. Do not begin any later milestone.
