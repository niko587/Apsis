# Performance Baseline

_Measured 2026-09-15. Diagnosis only — no optimization has been applied, and no
performance improvement is claimed anywhere in this document._

> ## Round 2 (2026-09-15, later) — the leading hypothesis was REFUTED
>
> The owner ran the A/B on the 2020 M1 MacBook Air:
> **normal FX — difficult to use; `?fx=off` — some improvement, still difficult
> to use.** Post-processing is a contributing factor and **not the primary
> bottleneck.** Section A below ("GPU fill rate — leading hypothesis") is
> therefore **wrong as a ranking**, and is left in place unedited because a
> baseline that quietly rewrites its own predictions is not evidence.
>
> Two things follow, and the second matters more than the first:
>
> 1. The remaining suspects are lead-sprite overdraw, the raymarched Core, CPU
>    work, and compositor/DPR cost — in unknown order.
> 2. **The two machines have different bottlenecks.** On the measuring machine
>    `fx=off` alone restores the full 60 fps vsync cap (15.7 → 60.2 fps); on the
>    M1 it barely helps. No further measurement *here* can identify the cause
>    *there*.
>
> So round 2 did not produce a verdict. It produced the instrument that will,
> on the owner's hardware, in about ninety seconds — see
> **"Diagnostic harness"** and **"What to run on the M1"** below. Naming a
> bottleneck now would be a guess, and the whole point of this document is that
> the project stopped guessing.

## The one thing to read first

**No frame rate in this document was measured on a GPU.** Every number here
comes from a machine whose browser rasterizes in software (SwiftShader), which
the project protocol already forbids quoting FPS from. What this machine *can*
establish — and what this document is built on — is structure: draw-call counts,
JavaScript self-time, allocation behaviour, and how cost *scales* with lead
count and with post-processing on or off.

The owner reports subjective grade **D** (laggy/unusable) on a 2020 M1
MacBook Air. This baseline identifies what is expensive and why, ranks the
candidates by evidence strength, and names the single decisive test that only
the M1 can run.

## Machine assumptions

| | Measuring machine | Owner's machine |
|---|---|---|
| GPU | SwiftShader (ANGLE/Vulkan, LLVM) — **software** | Apple M1, 7-core integrated |
| Thermals | n/a | **Fanless** — sustained load throttles |
| Memory | discrete heap | **Unified** — GPU and CPU share bandwidth |
| devicePixelRatio | **1** | **2** (Retina) |
| Canvas backing store | 1,270 × 944 = 1.20 Mpx | ~2880 × 1800 = **5.18 Mpx** at a typical window |

Three consequences for the M1 that follow directly from that table:

1. **~4.3× the fragments.** The canvas caps DPR at `[1, 2]`, so the Air renders
   roughly 4.3× the pixels this probe did. Every fill-rate cost below scales by
   that factor before the M1 sees it.
2. **Unified memory.** Bloom's mip chain and the half-float framebuffer consume
   the same bandwidth the CPU is using for the event pipeline. On discrete-GPU
   hardware these compete less.
3. **Fanless.** A load that is merely heavy on an M1 Pro becomes a thermal
   throttle on an Air, so *sustained* frame rate can be well below the first
   ten seconds. Any measurement taken on the Air should be taken after ~2
   minutes, not immediately.

## Current architecture (as measured, not as assumed)

- The **entire lead book is one `THREE.Points` draw call.** There are no
  per-lead React components. This was checked explicitly because it is the
  usual cause of this symptom, and it is **not** what Apsis does.
- **Draw calls: 29–40 per frame at every book size** (median 39 with effects,
  29–33 without). Batching is not a lever here; there is nothing to batch.
- DOM panels are already defended: `useThrottledRevision` (500/750/1000 ms),
  top-150 single-pass list selection, feed capped at 14 rendered rows,
  incremental telemetry (`telemetryAfterMove` carries counts forward instead of
  recounting), non-reactive `readLeads()`/`readOrder()` for the frame loop.
- Frame-loop hygiene is real: preallocated scratch vectors, a constant bounding
  sphere, trail and arc caps (400 / capped), buffer uploads skipped on idle
  frames.

This is a codebase that has already had one performance pass. The remaining
costs are structural, not sloppiness.

## Test configuration

Production build (`npm run build`) served by `vite preview` on :4173, viewport
1600×1000, 4 s settle, 8 s sample, CDP CPU profiler at 200 µs, WebGL draw calls
counted by patching `drawArrays`/`drawElements` before three.js acquires the
context. Instrumentation was injected at runtime via Playwright
`addInitScript` — **no source file was modified to take these measurements.**
Probe scripts live outside the repository (session scratchpad), as they are
measurement scaffolding rather than project code.

## Observed behaviour

FPS below is **software-rasterizer FPS**. Treat the *ratios between rows* as
signal and the *absolute values* as noise.

| Config | fps\* | frame p95 (ms) | draws/frame | heap (MB) |
|---|---|---|---|---|
| 4,892 fx=on | 1.0 | 1733 | 39 | 11.0 |
| 4,892 fx=off | 6.7 | 417 | 33 | 15.6 |
| 20,000 fx=on | 0.8 | 1583 | 39 | 27.4 |
| 20,000 fx=off | 2.4 | 750 | 29 | 27.2 |
| 60,000 fx=on | 0.2 | 9616 | 40 | 44.1 |
| 60,000 fx=off | 0.5 | 3733 | 29 | 52.7 |
| 4,892 fx=on + pointer moving | 0.5 | 3933 | 39 | 11.6 |
| 60,000 fx=on + pointer moving | 0.2 | 12500 | 39 | 41.7 |

### What `fx=off` tells us

Disabling post-processing is worth **4.2× at 4,892 leads**, 2.1× at 20k and
2.6× at 60k (frame-time p95; by median FPS, 6.7× / 3.0× / 2.5×). The effect is
**largest at the default book size** — the size the owner is running.

That shape is the signature of a cost that does not scale with lead count:
bloom is a fixed number of full-screen passes. `mipmapBlur` with `levels={5}`
is a down/up chain of roughly 2.7 full-screen-equivalents, plus an ACES tone
pass — **~13.8 Mpx of fragment work per frame on the M1's backing store**,
against ~3.5 Mpx for the entire 4,892-sprite lead field. On the numbers, bloom
costs about **4× what drawing every lead costs.**

### Scaling: 4,892 vs 20k vs 60k

With effects off, isolating geometry/fill from the post chain: 6.7 → 2.4 → 0.5
fps, i.e. 4.1× the leads costs 2.8× the time, and 12.3× the leads costs 13.4×.
Roughly **linear in lead count, with no cliff** — the architecture scales as
designed. Nothing here suggests an algorithmic blow-up in rendering.

Note what this means for the owner's complaint: **the default book is not a
scaling problem.** 4,892 leads is the cheap end of a curve that stays sane to
60,000. If the Air is at grade D on 4,892 leads, the cause is per-frame fixed
cost (fill rate), not the size of the book.

## Bottlenecks, by evidence strength

### A. GPU / fill rate — LEADING HYPOTHESIS, not yet proven on real hardware

Evidence: the 4.2× `fx=off` improvement at the default book; bloom's fragment
budget computing to ~4× the lead field's; `(program)` (the rasterizer) holding
86–98% of all profiler samples in every configuration; cost tracking pixel
count rather than lead count. Compounding factors specific to this app: the
sprite material is `AdditiveBlending` with `depthWrite: false`, so there is
**no early-z rejection and full overdraw** on the dense cold rim, and the
fragment shader `discard`s outside a radius *after* being scheduled.

Why it is a hypothesis and not a finding: a software rasterizer is fill-bound
by construction, so this machine would produce that signature whether or not
the M1 is fill-bound. **It cannot distinguish "bloom is expensive" from "this
renderer is slow at everything."**

**Decisive test, ~2 minutes on the Air:** open `/` and `/?fx=off` at a fixed
window size, let each settle 2 minutes (thermal), and compare. If `fx=off` is
dramatically better, fill rate is confirmed primary and the fix is cheap and
non-architectural. If it is barely better, this section is wrong and B moves up.

### B. CPU / JavaScript — CONFIRMED real, magnitude modest at the default book

The hottest JavaScript function in Apsis is **a CSS colour-string parser.**

`THREE.Color.setStyle` is the single largest JS self-time entry in nearly every
configuration: 38.9 ms/8 s at 4,892 leads, 149 ms at 20k, **273 ms at 60k** —
~48% of all non-rasterizer JS self-time at 60k. It is reached from
`LeadField`'s revision walk: `scratch.set(colorFor(lead.stage))` re-parses a
literal like `'#2f6bff'` through three.js's regex path, once per lead.

Alongside it, `positionFor` (minified `tS`, identified from the bundle:
`function tS(e){…return{x:…,y:…,z:…}}`) shows 150 ms/8 s at 60k and **allocates
a fresh object per lead per call**, with `(garbage collector)` tracking it
(89–149 ms at 60k).

The root cause of both is one design choice in `LeadField.useFrame`:

```
if (revision !== lastRevision.current || matched !== … || drillPath !== …) {
  for (let i = 0; i < order.length; i++) { … positionFor … Color.set(colorFor…) }
}
```

`revision` bumps on **every ingested event** (~9/s), and each bump rewalks the
**entire book** — recomputing position and re-parsing a colour for all 4,892
(or 60,000) leads because *one* lead changed. The work is O(book) per event
where O(1) is correct.

Magnitude, honestly stated: total non-rasterizer JS is ~2–3% of main-thread
samples at 4,892 leads and ~12–14% at 20k–60k. So this is **real, clearly
avoidable waste that scales badly — but it is unlikely to be what makes the
Air feel like grade D at the default book size.** It is the highest-value
*cheap* fix, not necessarily the highest-impact one.

### C. React reconciliation — NOT a bottleneck

`beginWork` (minified `Dc`) reaches 38.4 ms/8 s only in the pointer-move pass.
No per-lead components exist. The throttled-revision design is doing its job.
**The hypothesis that thousands of React components are being rendered for
leads is disproven.**

### D. Zustand / state updates — NOT a bottleneck in itself

`ingest` mutates the Map in place and bumps a counter rather than cloning;
telemetry is incremental. The store is not the problem — but it is the *trigger*
for B, because `revision` is a single global counter that cannot say *which*
lead changed. That is the design gap B depends on.

### E. `useFrame` — CONFIRMED, concentrated in one loop

R3F's frame driver (minified `Ov`, identified as the `useFrame` subscriber
runner) reaches **703 ms/8 s at 20k leads** and 409.7 ms at 60k with the
pointer moving. `LeadField`'s per-frame loop is unconditionally `O(count)`:
even on a completely settled field it runs 3 subtractions, a dot product and a
comparison for every lead, every frame, plus the same again for the trail.

### F. Shaders / post-processing — see A

The Core's fragment shader is 16 steps × 3-octave fbm × 8 hashes ≈ **384 hash
evaluations per fragment**. That is genuinely expensive *per pixel*, but the
Core covers a small screen area at the default camera — so its total cost is
modest unless the user zooms in, at which point it grows quadratically with
apparent radius. Worth watching, not currently indicted.

### G. Object / geometry / material creation — CLEAN except `positionFor`

All buffers, geometries and materials are created once in `useMemo`. Scratch
vectors are preallocated. The only per-frame/per-event allocation found is
`positionFor`'s returned object (see B).

### H. DOM / CSS / layout — NOT a bottleneck

No layout thrash observed. The rail is capped and throttled. One note: `.rail`
and four inner lists are independent scroll containers with
`overscroll-behavior`, which is correct but does create additional compositing
layers — irrelevant beside fill rate.

### I. Event stream / update frequency — CONTRIBUTING via B

~9 events/s, each bumping `revision`, each triggering a full-book rewalk. The
event rate is reasonable; what it triggers is not.

## Highest-impact optimization opportunities

Ordered by **expected impact ÷ risk**, not by ease.

1. **Make the bloom chain cheaper, and/or clamp DPR under load.** Lowering
   `levels`, resolution-scaling the bloom pass, or capping `dpr` to 1.5 on
   integrated GPUs attacks the cost the `fx=off` comparison says is ~4× the
   entire lead field. *Blocked on the M1 `fx=off` result — do not start here
   until that test confirms A.*
2. **Stop rewalking the book on every event.** Either have `ingest` record
   which lead changed (a dirty set) and update only those indices, or gate the
   walk behind the same throttle the DOM panels already use. Removes the
   `setStyle` and `positionFor` cost almost entirely.
3. **Precompute stage colours once** as `Float32Array` RGB triples keyed by
   stage, so no colour string is ever parsed in a hot path. This is a ~10-line
   change that deletes the app's hottest JS function outright.
4. **Give `positionFor` an out-parameter variant** (`positionInto(lead, out)`)
   so the frame path allocates nothing. Keep the allocating version for callers
   that want it.
5. **Bound pointer raycasting.** `Points` raycasting is O(n) per pointer move;
   at 60k that is the largest single JS entry. A spatial grid, a coarser
   `threshold`, or throttling hover to ~20 Hz would each cap it.
6. **Early-out the settled-field frame loop.** Track a "anything moving" flag so
   a quiet field costs O(1) per frame instead of O(book).

## Risks and tradeoffs

- **Items 1 is the only one that can damage the product's look.** The
  cinematic quality is the point of Apsis; reducing bloom levels or DPR trades
  visual richness for frames and must be reviewed visually, ideally as a
  quality tier rather than a flat downgrade.
- **Items 2–6 are behaviour-preserving** and carry no visual risk — they
  compute the same values with less waste. Item 2 is the only one that touches
  an architectural seam (it needs `ingest` to report *what* changed), and it
  must not introduce a second mutator: the D1 invariant (`ingest` is the only
  mutator) stays intact, since a dirty-set is an output of ingest, not a new
  way to change a lead.
- **Do not "fix" items 2–6 and declare victory** if A turns out to be primary.
  They would improve 60k behaviour measurably and the default book barely.
- Every optimization must be re-measured on the Air. This machine cannot
  confirm any of them.

## Recommended order

1. **Owner runs the `fx=off` A/B on the M1** (2 minutes). This decides whether
   the work is graphics or JavaScript, and nothing should be optimized before
   it is known.
2. Items 3 and 4 regardless of that answer — they are tiny, safe, and delete
   the measured hot path.
3. Item 2, which subsumes most of the remaining JS cost.
4. Item 1 only if the A/B confirms fill rate, and only as a reviewed visual
   tier.
5. Items 5 and 6 as follow-ups, primarily for large books.

## What this baseline does not establish

- Any real-GPU frame rate, at any book size, with or without effects.
- Whether the M1's grade-D experience is dominated by fill rate or by
  JavaScript. The evidence leans fill rate; it is not proven.
- Whether thermal throttling is a significant contributor on the fanless Air.
- The Core shader's real cost at close camera distances.

---

# Round 2: the diagnostic harness

## Why an instrument instead of another opinion

Round 1 measured hard and still guessed wrong, for a reason worth keeping: a
software rasterizer is fill-bound at everything, so it reports "fill rate" no
matter which suspect is actually guilty. The M1 A/B refuted that reading in two
minutes. The lesson is not "measure more carefully here" — it is that **this
machine cannot answer the question at all**, and the only fix is to put the
instrument on the machine that has the symptom.

## Diagnostic harness

`src/diag/diagnostics.ts` + `src/diag/DiagOverlay.tsx`. **Everything is off by
default**: with no diagnostic parameter the flags resolve to exactly the
shipping configuration, the probe is never installed, and no diagnostic code
runs in a frame. Verified: a default page load renders the same 9 rail panels,
150 list rows, live feed and full 3D scene as before, with no overlay.

| Parameter | Effect | Isolates |
|---|---|---|
| `?diag=1` | live overlay | — |
| `?bench=1` | walks the whole matrix, prints a copyable table | — |
| `?dpr=N` | force devicePixelRatio | pixel count / fill rate |
| `?field=off` | stop drawing lead points | additive sprite overdraw |
| `?core=off` | stop drawing the Intelligence Core | the 384-hash/fragment raymarch |
| `?feed=off` | stop the simulated event source | the per-event full-book revision walk |
| `?anim=off` | freeze ambient motion (routes through the existing reduced-motion path) | animation work |
| `?fx=off`, `?leads=N` | existing | post-processing, book size |

Nothing is removed from the product: every flag defaults to on, a typo
degrades to the shipping configuration, and no feature was deleted to make a
measurement possible.

### How it separates CPU from GPU

The probe wraps `renderer.render()` and times it, and separately samples the
frame interval:

- **`render()` CPU ms** — scene traversal, matrix and uniform updates, buffer
  uploads, draw-call submission. Real main-thread work.
- **other ms** — frame interval minus the above: `useFrame` callbacks, React,
  and any time the main thread spends waiting on the GPU.

`render()` returns when draw calls are *submitted*, not *executed*, so
`renderMs ≈ frameMs` means CPU-bound and `renderMs ≪ frameMs` means the frame
is limited by something else — and with the drawing toggles off one at a time,
which something becomes unambiguous. Where the driver exposes
`EXT_disjoint_timer_query_webgl2` the harness reports true GPU execution time
directly; Chrome usually withholds it, so the inference above is the fallback
rather than the plan.

One accounting bug found and fixed while validating the instrument:
`renderer.info.render` resets on every `render()` call and the post pipeline
makes several per frame, so sampling it from outside reported a single
full-screen triangle — "1 draw call" for the app's busiest configuration.
Totals are now summed inside the wrapper (correct: 45 draws, 4,892 points).

## Measuring-machine reference (software rasterizer — a CONTRAST, not a prediction)

4,892 leads, 1280×800, dpr 1:

| config | fps | frame ms | render() CPU ms | other ms | draws |
|---|---|---|---|---|---|
| baseline | 15.7 | 63.7 | 0.5 | 63.2 | 45 |
| fx=off | **60.2** | 16.6 | 0.4 | 16.2 | 34 |
| fx=off dpr=1 | 59.9 | 16.7 | 0.3 | 16.4 | 34 |
| fx=off dpr=1 core=off | 59.9 | 16.7 | 0.3 | 16.4 | 33 |
| fx=off dpr=1 field=off | 59.9 | 16.7 | 0.3 | 16.4 | 32 |
| fx=off dpr=1 field=off core=off | 59.9 | 16.7 | 0.3 | 16.4 | 31 |
| feed=off (fx on) | 19.1 | 52.3 | 0.4 | 51.9 | 37 |
| anim=off (fx on) | 17.8 | 56.1 | 0.4 | 55.7 | 45 |
| dpr=1 only (fx on) | 17.2 | 58.0 | 0.5 | 57.5 | 45 |

Three readings, all of which transfer even though the frame rates do not:

1. **`render()` CPU time is 0.3–0.5 ms in every single configuration.** Three.js
   scene-graph and submission cost is negligible at this book size. Bottleneck
   **E (excessive Three.js object updates) is effectively ruled out**, here and
   almost certainly on the M1 — 4,892 points in one draw call is simply not
   much CPU work to submit.
2. **Every `fx=off` row is pinned at the 60 fps vsync cap**, so the subtraction
   steps below it cannot discriminate on this machine. On the M1, where
   `fx=off` does *not* reach the cap, those same rows will separate cleanly.
   This is exactly why the matrix has to run there.
3. **`feed=off` is worth 15.7 → 19.1 fps with effects still on** (~22%). The
   per-event full-book revision walk is a real, measurable cost even when it is
   competing with a rasterizer that dwarfs it — which is a stronger signal for
   it than round 1's profile gave.

## What to run on the M1

One URL, about ninety seconds, then copy the textarea it prints:

```
http://localhost:4173/?bench=1
```

and, if you have another minute, the 20k pass:

```
http://localhost:4173/?bench=1&leads=20000
```

Before either: open `chrome://gpu`, confirm **WebGL: Hardware accelerated**,
and note the GL_RENDERER string. Use a normal window, do not resize mid-run,
and let the machine idle first — the Air is fanless, so a warm machine reports
a throttled number and a cold one reports an optimistic one.

For poking around by hand instead, `?diag=1` can be combined with any flags,
e.g. `?diag=1&fx=off&field=off` — the overlay names its own verdict.

## How to read the result (decided in advance, so the data picks)

The ranking is whichever adjacent pair shows the largest jump. Committing to
the interpretation before seeing the numbers is deliberate — it is what stops
the next round from rationalising whatever appears.

- Large jump at **`field=off`** → additive sprite overdraw is primary. The fix
  is fragment cost per sprite (smaller sprites, cheaper fragment shader, or
  depth-sorted/opaque-cored sprites), not fewer leads. **The book stays whole.**
- Large jump at **`core=off`** → the raymarch is primary. The fix is step count,
  resolution, or rendering the Core to a smaller buffer — its silhouette and
  behaviour survive all three.
- Large jump at **`dpr=1`** → raw pixel count. The fix is a resolution tier,
  and it is the one honest place where visual quality trades against frames.
- **All drawing off and still slow** → CPU. The fix is the revision walk
  (items 2–4 in round 1's list), and it costs nothing visually.
- `feed=off` large while drawing toggles are small → the event pipeline, same
  fix, same zero visual cost.

## Status

**No primary bottleneck is claimed for the M1.** Round 1's candidate was
refuted by real hardware; round 2 built the instrument rather than substituting
a second guess. The next action is the owner running `?bench=1` — after which
the fix is chosen by the table, not by argument.

---

# Round 3: interaction and jank

_2026-09-15. **No bottleneck confirmed. This round rules things out and designs
the next measurement.** Nothing was optimized._

## Why round 2's table said nothing

All nine configurations on the M1 reported **58.8 fps / 17.0 ms**, identical to
one decimal — including `field=off`, which stops drawing all 4,892 sprites, and
`core=off`, which removes the raymarch. Two readings, both true:

1. **58.8 fps / 17.0 ms is the vsync interval, quantised.** The median of
   vsync-locked frames *is* exactly one refresh period, so nine identical rows
   are expected and carry no information. They are not evidence that the flags
   failed to apply.
2. **A median cannot see jank.** A page can hold a 60 fps median through a
   200 ms stall every few seconds and still report 58.8. Round 2 measured a
   median, on an idle page, when the complaint is about *interacting*.

## What round 3 measures

Added to the harness, all still off by default: frame-time **distribution**
(mean/median/p95/p99/max and counts over 20/33/50/100 ms), **long tasks** via
`PerformanceObserver`, **input latency** via the Event Timing API (the direct
measure of "feels laggy at 60 fps" — `processingStart − startTime`), and
**per-code-path spans** timing `ingest`, the full-book revision walk,
`Points.raycast` and the whole `LeadField` frame callback. Plus two repeatable
scripted interactions: `?sweep=1` (pointer, hover/raycast) and `?sweep=drag`
(button held, driving OrbitControls — the interaction a person actually
performs, and the one round 3's first pass missed).

Frame times from the measuring machine remain meaningless — every frame there
is a long task because the software rasterizer saturates the main thread. **Span
durations are pure JavaScript and do transfer.**

## Measured code-path costs at 4,892 leads

Medians across idle / pointer-sweep / drag-sweep runs, 10 s each:

| path | mean | max | calls/s observed | implied at 60 fps on a fast CPU |
|---|---|---|---|---|
| `revisionWalk` (full book) | 1.71–2.05 ms | 5.8 ms | ~3.4 (frame-gated) | ~9/s → **~16 ms/s** |
| `pointsRaycast` (all 4,892) | 0.094–0.103 ms | 1.9 ms | ~11 | ~60/s → ~6 ms/s |
| `leadFieldFrame`, settled | 0.063 ms | 0.2 ms | every frame | ~4 ms/s |
| `ingest` (incl. subscribers) | 0.039–0.056 ms | 0.8 ms | ~4.6 | ~9/s → ~0.5 ms/s |

**Total ≈ 27 ms of JavaScript per wall-clock second — about 2.7% of one core.**

### Three things now confirmed as facts rather than inferences

- **The full-book revision walk is real.** 166,328 leads recalculated in 10 s to
  service 50 events (`revisionWalks=34`, `leadsRecalculated=166,328`). One event
  changes one lead; the walk recomputes `positionFor` and re-parses a colour
  string for all of them. At 1.8–2.1 ms it is a genuine *tail* contributor
  (~12% of a 16.7 ms frame budget when it lands) and **not** the cause of a
  sustained grade-D experience.
- **`THREE.Points` raycasting does scan every lead.** 596,824 points scanned
  across 122 raycasts = exactly 4,892 per call, confirming the O(n) path with no
  acceleration structure. At 0.094 ms it is **cheap at this book size** (it
  would matter at 60k).
- **The settled-field frame loop costs 0.063 ms.** The unconditional `O(count)`
  loop is not a problem at 4,892 leads; `framesWithNoMovement` confirms it runs
  on every frame while the field is visually still, and it still costs almost
  nothing.

## Conclusion: what this rules OUT

At 4,892 leads, on a CPU of this class, **JavaScript cannot account for the
owner's lag.** Specifically ruled out as primary:

- **C. CPU/main-thread JS** — ~2.7% of one core, total.
- **D. React reconciliation** — `ingest` measures 0.055 ms *including* every
  synchronous Zustand subscriber it wakes.
- **E. Three.js object updates** — `render()` CPU is 0.0–0.5 ms everywhere.
- **Pointer raycasting** — real and O(n), but 0.1 ms per call here.
- **The revision walk** — real and wasteful, but ~16 ms/s.
- **B. Vertex/particle workload** and draw-call count — 29–45 draws, one
  `Points` call for the book.

And from round 2 on the owner's own hardware: **A (fill rate) and F
(post-processing)** are not primary either — removing the field, the Core and
the post chain changed the frame time by nothing.

**So every candidate the current instruments can see has been eliminated.**
That is a real result, and it means the next step is a different instrument,
not another guess.

## What is still unmeasured on the M1 — the next measurement

The harness now reports everything needed; it simply has not been run there.
**This is the action, and it is the owner's:**

```
http://localhost:4173/?jank=1&seconds=15        # idle: tail + long tasks
http://localhost:4173/?sweep=1&seconds=15       # hover/raycast under pointer motion
http://localhost:4173/?sweep=drag&seconds=15    # orbiting — the real interaction
```

Each prints a copyable block. The three outcomes and what each would mean:

1. **p99/max large, long tasks present** → main-thread jank after all, and the
   spans in the same report name the culprit directly. The revision walk is the
   leading candidate in that branch.
2. **Distribution clean but input-latency delay high** → the frame loop is fine
   and the *input path* is not. That is a compositor/event-routing problem, and
   the fix is in how pointer events are handled, not in the renderer.
3. **Everything clean on the M1 too** → the lag is not where the app is looking,
   and the next questions are environmental rather than architectural. Those
   need answering before any more code is measured:
   - **Was the grade-D experience on `npm run dev` or on the production
     preview?** The dev server runs unminified React with StrictMode
     double-invoking renders and effects; it is legitimately much slower, and it
     would explain a bad experience that a production-build benchmark cannot
     reproduce.
   - Chrome or Safari? (Safari lacks `longtask`; the report says so rather than
     printing zeros.)
   - Low Power Mode, battery vs mains, external display, browser zoom, other
     heavy tabs — each changes an M1 Air's behaviour substantially.

## Honest status

**A. Confirmed bottleneck:** none. Every measurable candidate is eliminated;
the cause has not been found.
**B. Evidence:** above — spans, counters, and the owner's own nine-row table.
**C. Magnitude:** total JS ≈ 2.7% of one core at 4,892 leads.
**D. Exact code path:** the only genuinely wasteful path found is
`LeadField.useFrame`'s revision-gated full-book walk
(`positionFor` + `THREE.Color.setStyle` per lead, ~9×/s) — real waste, wrong
order of magnitude to be the cause.
**E. Smallest safe fix:** deferred. Fixing the walk is worth doing on its own
merits (round 1 items 3–4) but must not be sold as the cure.
**F. Expected impact:** on the evidence, ~16 ms/s of a 1000 ms second at the
default book — invisible to a human. Substantial only at 20k+ leads.
**G. Risk:** none of the above touches visuals; the risk is doing it, seeing no
improvement, and concluding performance work is hopeless. It is not hopeless —
it is unlocated.

---

# Round 4: dev vs production, and a defect in the instrument

_2026-09-15. No application code changed. No optimization. Docs only._

## The M1 production numbers are healthy

Owner's round-3 runs on the 2020 M1 Air against the production preview:

| run | frames | mean | median | p95 | p99 | max | >33ms | >50ms | long tasks |
|---|---|---|---|---|---|---|---|---|---|
| idle | 886 | 16.9 | 17 | 20 | 26 | 142 | 5 | 2 | **0** |
| pointer sweep | 882 | 17.0 | 17 | 19 | 27 | 126 | 7 | 5 | **0** |
| drag sweep | 901 | 16.7 | 17 | 19 | 23 | **28** | **0** | **0** | **0** |

No input event exceeded 16 ms. Spans matched the measuring machine almost
exactly (`revisionWalk` ~1.76 ms, `leadFieldFrame` ~0.34 ms, `ingest` ~0.05 ms,
`pointsRaycast` ~0.05 ms).

**That is a well-behaved 60 fps application.** The drag sweep — the interaction
most likely to feel bad — did not produce a single frame over 33 ms across 901
frames. This should be read as evidence that **the harness is measuring
something other than what the owner experiences**, not as evidence the app is
fine. The owner's report stands.

## How to run each mode

```bash
export PATH=/usr/local/bin:$PATH     # node lives only here on this machine
cd ~/Downloads/apsis

npm run dev                          # development  -> http://localhost:5173
npm run build && npm run preview -- --port 4173   # production -> :4173
```

Both can run at once; the ports are what distinguish the two builds.

## Dev vs production — the differences that matter

- **StrictMode is active** (`src/main.tsx:6` wraps `<App />`). The component
  exists in both builds, but its double-invoke behaviour — rendering every
  component twice and mounting→unmounting→remounting every effect — is
  **development-only**. Production skips it.
- **React is unminified in dev and is a different build**: prop-type checks,
  dev warnings, richer errors, profiling hooks. Reconciliation is materially
  slower independent of StrictMode.
- **Vite serves unbundled ESM in dev** with on-the-fly transforms and an HMR
  WebSocket; production serves one minified bundle.
- **Production removes all three.** Every benchmark in rounds 2–4 targeted
  `:4173` for exactly that reason.

## Measured, not asserted (measuring machine, identical harness, 8 s windows)

| | DEV (5173) | PROD (4173) | ratio |
|---|---|---|---|
| long tasks, idle | 188 (14,550 ms) | 100 (7,964 ms) | **1.9×** |
| long tasks, drag | 196 (14,802 ms) | 106 (7,886 ms) | **1.85×** |
| load time / resource requests | 529 ms / 63 | 122 ms / 2 | 4.3× |
| `revisionWalk` mean | 1.837 / 1.657 ms | 1.792 / 1.726 ms | 1.0× |
| `leadFieldFrame` mean | 0.727 / 0.551 ms | 0.542 / 0.536 ms | ~1.0× |
| `ingest` mean | 0.060 / 0.054 ms | 0.068 / 0.032 ms | ~1.0× |

**The finding: dev roughly doubles main-thread long-task load, and the penalty
does not appear in any instrumented span.** The spans time Apsis's own code
paths; the dev cost lands in React's render work, which nothing here measures.
So a dev-mode session can feel substantially worse while every span reads
normal — which is precisely the shape of the owner's situation.

This does not prove the owner was running dev. It establishes that dev is
measurably worse in a way the current instruments would *not* attribute, and
that the hypothesis is worth one direct test rather than more inference.

## Defect found in the instrument (disclosed, not silently patched)

`installLongTaskObserver()` catches the `observe()` failure but leaves the
counters at zero, and the report only prints "unsupported" when
`PerformanceObserver` itself is absent. **Safari implements
`PerformanceObserver` but not the `longtask` entry type** — so a Safari run
reports `count=0 total=0 max=0`, which reads as "no jank" when it actually
means "cannot see jank".

**Consequence: the owner's "0 long tasks" is only meaningful if the runs were
in Chrome.** If they were in Safari, that line is a false negative and the
jank question is still open on that browser. The one-line fix is to track
whether `observe()` succeeded and print "unsupported" when it did not; it was
not applied because round 4 was scoped to no application-code changes.

## Exact next test

Two runs in **dev**, to compare against the production numbers already in hand:

```
http://localhost:5173/?jank=1&seconds=15
http://localhost:5173/?sweep=drag&seconds=15
```

Label them (the report header does not yet record build mode — see below), and
answer three questions:

1. **Which URL/port is the everyday one?** If the grade-D experience is on
   `:5173`, the comparison above is the explanation and the fix is "use the
   production build", not a code change.
2. **Chrome or Safari?** If Safari, the long-task line in every report so far
   is a false negative, and the next measurement must be a Safari Web Inspector
   timeline instead of `PerformanceObserver`.
3. **Battery or mains, Low Power Mode, external display, browser zoom?** Each
   changes a fanless M1 Air materially, and none is visible to the harness.

Known gap: the report header records mode, leads, fx, dpr, window size and
user-agent, but **not whether the bundle was built in dev or production**, so
two pasted reports are indistinguishable without labelling. Fix is one line
using `import.meta.env.MODE`; deferred for the same scope reason.

## Status

No bottleneck confirmed. No optimization implemented. The production build on
the owner's M1 measures healthy; dev measures ~1.9× the long-task load; the
owner's subjective report is unexplained and stands.
