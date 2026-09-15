# Apsis

An AI Sales Operating System whose primary surface is a living 3D **Lead Universe**.

An *apsis* is a point of extreme approach on an orbit: **apoapsis** the farthest,
**periapsis** the nearest. A cold lead sits at apoapsis on the outer rim; a
qualified booked appointment is periapsis at the centre. The product is the
journey along that line.

Built from `APSIS_MASTER_BUILD_PROMPT.md`. Independent of, and sharing no code
with, the separate Cortex project.

## Run

```
npm install
npm run dev      # http://localhost:5173
npm test         # domain invariants
npm run build
```

## Architecture

The load-bearing rule is one-directional: **score is the only thing that moves a
lead.** Nothing tweens, and the 3D layer holds no state of its own.

```
LeadEvent  →  scoring.applyEvent  →  score  →  gravity.radiusFor  →  position
   ↑                                   ↓
event source                    store (telemetry, legend, feed)
```

| Module | Responsibility |
|---|---|
| `src/domain/types.ts` | `Lead`, `Stage`, `LeadEvent`. Stage bands. |
| `src/domain/scoring.ts` | Event → score. Pure, deterministic, no clock. |
| `src/domain/gravity.ts` | Score → orbital radius and world position. |
| `src/domain/seed.ts` | Deterministic 4,892-lead book (mulberry32, fixed seed). |
| `src/domain/geography.ts` | National metro table — city, state, census region, area code, population weight. |
| `src/state/store.ts` | Zustand. `ingest(event)` is the only mutator. |
| `src/domain/agents.ts` | Which agent does what, and how long it takes. |
| `src/domain/query.ts` | Command parsing and execution over the lead book. |
| `src/domain/appointments.ts` | Scheduling, advisors, status (§16). |
| `src/domain/nextAction.ts` | Derived next-best-action per lead (§14). |
| `src/state/source.ts` | **The adapter boundary — see below.** |
| `src/universe/` | R3F. Reads the store; never writes to it. |
| `src/ui/LeadList.tsx` | The Universe as accessible DOM — see Accessibility. |
| `src/orchestrator/*` | Model routing, capability detection, handoff (§30-40). |

### Design decisions worth knowing

**Radius comes from stage index, not raw score.** The score bands are uneven by
design — `cold` spans 20 points, `booked` spans 1. Mapping score straight to
radius squeezes the four late stages into a sliver and the Universe reads as one
fat cold ring. Each stage gets an equal annulus instead, so every stage is
legible and within-stage progress still shows as drift.

**Engagement asymptotes below `booked`.** Positive events damp to zero at
`TOUCH_CEILING` (98). No volume of replies or calls can reach periapsis; only an
`appointment_booked` event crosses into the booked band. The centre means a
booking or it means nothing.

**Negative events move leads back out.** Objections, cancellations and going cold
all push outward, and idle leads decay after a 72h grace period. A one-way
universe would be a progress bar, not a picture of a pipeline.

**Agent work is a task with a lifetime, not a label on an event.** Outbound
events (`contacted`, `call_connected`, `appointment_booked`) are produced by an
`AgentTask` that occupies its agent, holds a claim on the lead so two agents
cannot work the same person, and resolves into a `LeadEvent` when it finishes.
Inbound events (`opened`, `replied`, `objection`) are things the lead did and
land immediately. The arcs in the Universe are those in-flight tasks, one to one.

**Agent assignment depends on the lead, not just the event.** Outreach channel
is a stable hash of the lead id, so a given person is always worked by SMS or
always by email. A lead going cold from `cold` is routine follow-up; one going
cold after reaching engaged is a lapsed opportunity and routes to reactivation.
Keying purely off event kind left two of seven agents unreachable — rostered,
rendered, permanently idle — which a test now guards against.

**The command bar reports what it did NOT understand.** §13 asks the interface to
show what Apsis understood; showing the leftovers matters more. A parser that
silently drops the clause it cannot handle returns a confident answer for the
rest, and "no leads match" becomes indistinguishable from "I ignored your most
important filter". Unparsed words come back as `ignored: …` chips.

Parse order is load-bearing for the same reason. "haven't been **contacted** in
14+ days" is a recency clause whose wording contains a stage name — matching
stages first turned it into `cold AND contacted`, which no lead can satisfy, so
it returned zero and looked like a legitimate empty result. Recognised spans are
now blanked out of the text as they are consumed, and recency parses first.

**The funnel is the answer, not the count.** "19 leads" is unreadable alone;
`4,892 scanned → 693 family → 88 Tampa → 49 cold → 28 idle 14+ days` tells you
which clause did the work. It also makes contradictory queries obvious: "qualified
leads with score above 80" shows `376 qualified → 0 score > 80`, because the
qualified band tops out at 76.

**Lead size scales with viewport height, not a fixed pixel count.**
`gl_PointSize` is in pixels, so a constant makes each lead cover a far larger
share of a short canvas than a tall one — on the stacked mobile layout the same
4,892 points overlapped into one saturated mass and every stage ring vanished.
Responsive here is not only layout; the visualization's density has to adapt too.

**Appointments are records, not a timestamp on the lead.** §16 requires name,
time, type, advisor and status. Slots are deterministic from the lead id, always
land in a weekday business-hours window, and never book with under 24h notice —
so booking late on a Friday correctly lands on Monday. Leads that start booked
get a record too; otherwise the centre reported "24 booked" beside a ledger
listing 3, because only leads that passed an `appointment_booked` event this
session had one.

**One shared hash, with an avalanche finalizer.** Appointment slots and agent
channel routing both derive from a stable hash of the lead id, and both read its
HIGH bits. Plain FNV-1a avalanches poorly there for short near-identical inputs
like `lead_0000`, `lead_0001` — the first twenty leads produced five distinct
appointment slots instead of sixteen, and the SMS/email split came out 2641/2251
where it should be ~2544/2348. A murmur3 finalizer fixes both. Shared rather than
copied, because a distribution bug fixed in one copy is still live in the other.

**Next best action is derived, never stored.** It is a pure function of the
lead's live state, so it cannot go stale — the moment a score moves or an agent
picks the lead up, the advice recomputes. A stored recommendation needs
invalidating on every event that could affect it, and the failure mode is a
confident "call now" for someone an agent is already calling. It also refuses to
recommend anything for a booked lead, and honours the lead's stated channel:
recommending a phone call to someone who asked to be emailed is worse than
recommending nothing.

**The Core's animation is phase-driven, dithered, and periodic — because it
used to glitch.** Three causes, all structural (full rationale in
`src/universe/Core.tsx`): the 16-step march sampled fbm whose finest octave is
~4× smaller than the step, and with every pixel starting at the same half-step
offset that undersampling organised into banding shells that popped as the
field moved — now the march start is staggered per pixel with interleaved
gradient noise, turning the error into static grain that bloom absorbs. The
noise frequency was derived from the breathing radius, so the whole pattern
zoom-pulsed at the breathing rate and filaments flickered hardest exactly when
the pipeline was busy — the frequency is now a fixed uniform; the breath still
moves the silhouette, not the pattern. And raw elapsed seconds fed the shader
directly, degrading float32 precision over hours — time now arrives as two
wrapped phases over a lattice made periodic (integer lacunarity, per-corner
mod) so the wrap is seamless: verified numerically, the field at phase 0 and
phase+period differ by at most 4e-6, float32 rounding itself. Worth recording:
the original diagnosis blamed hash precision, and float32 emulation *disproved*
that — the old hash kept ~83% distinct values even at 8 hours' uptime. The
degradation was real but hours-slow; the immediate glitch was the two causes
above. Measure before fixing, even when the story sounds right.

**The book is national, and weighted by population.** It used to be nine
Florida cities, which made the §15 drill dishonest: the first level offered
exactly one choice and `GLOBAL → Florida` went from 4,892 leads to 4,892 leads.
A drill level that cannot partition anything is a click that costs a step and
returns nothing. `geography.ts` now carries ~90 metros across 51 states and DC,
sampled by metro population — so New York, Los Angeles and Chicago carry real
mass and Cheyenne is a scattering of nodes, rather than a uniform sprinkle that
would make every state look equally worked. Area codes belong to their metro,
because a Tampa lead with a Seattle phone number is the kind of detail that
quietly tells you the whole book is invented. A test guards each of these:
regions present, states > 40, largest state > 5× the median, one area code per
metro.

**Region leads the drill because forty-four chips is a search, not a glance.**
The order is Universe → region → state → city → segment. Going straight to
states would put every state the book touches on the first screen; the four
census regions divide it into something scannable, and each subsequent level
divides the one above it — South → 17 states, Texas → 4 cities, Dallas → 7
segments. The registry is still open: adding campaign, source or agent (all
named in §15) is a `ClusterDimension` entry plus a slot in `DRILL_SEQUENCE`.

**Cluster chips scroll; they do not truncate.** An earlier version showed twelve
and appended "…and N more", which was fine for nine Florida cities and wrong the
moment the book went national — the South alone spans seventeen states, so the
state a user wants is frequently past the cut. Same mistake as the clipped rail:
content that exists, is correct, and cannot be reached.

**State abbreviations are matched case-sensitively, city names longest-first.**
Two-letter postal codes are a minefield in free text — `ME`, `OR`, `IN`, `OK`,
`HI` and `DE` are all ordinary English words, so a case-insensitive match turns
"find **me** leads" into a filter for Maine and returns a confident wrong answer.
Requiring uppercase in what the user actually typed is the signal that separates
a postal code from a word. City names are scanned longest-first for the mirror
reason: matching "Kansas" before "Kansas City" eats half the name and leaves
"city" behind as an unrecognised word. Both are covered by tests that assert the
*absence* of a match, which is the direction that actually fails silently.

**The rail scrolls, and every panel owns a bounded band of it.** The rail was
`overflow: hidden` around nine panels whose natural height (1,603px) exceeded any
viewport. That is not "it fits" — it is *the overflow is unreachable and there is
no scrollbar to admit it*. At 1600×1000 it clipped five panels outright: the
agent roster, the temperature legend, the Model Orchestrator, the live activity
feed, and the Leads list — the last being the §21 accessible equivalent of the
canvas, and §17's telemetry being most of the rest. The two `.panel.grow` panels
made it worse rather than better: `flex: 1` measures free space against the
rail's own height, which the content already exceeded, so they resolved to a
28px header with an empty body. The failure mode is the bad one — it looked like
a deliberately sparse rail rather than a broken one.

Fixed by making the rail a scroller and giving each list a capped band
(appointments 246px, leads 304px, feed 218px) so no single panel can push its
neighbours past the fold. The appointments ledger alone had been taking 586px of
944. Verified at five viewports from 420px to 2560px: nine panels present, none
collapsed, no horizontal overflow, and lead rows selectable by mouse.

**Stage bands tile the reals, not the integers.** `[lo, hi)` half-open and
adjacent. An earlier inclusive-integer version (`0-20`, `21-40`, …) left score
20.5 in no stage at all, which made the radius non-monotonic — a lead ticking
from 20.5 to 21 jumped *outward*. Covered by a test that steps in 0.25s.

## What is real and what is not

Real: the domain model, scoring, decay, gravity, the store, the event pipeline,
telemetry, and the rendering. All of it is exercised by the UI you see.

Not real: **the data source.** There is no CRM wired up yet.
`src/state/source.ts` is a stand-in for the thing production plugs in — a CRM
webhook feed, a dialer socket, an SSE stream off the agent runner. It emits
stage-aware `LeadEvent`s and does nothing else; it never moves a lead directly.
Swapping it for a real transport means replacing that one file, because
everything downstream depends on the `LeadEvent` type rather than on it.

## Performance

Measured, not assumed — 5s rAF counts under Playwright with **SwiftShader
software rasterization**, which is a harsher test than any real GPU:

| Leads | FPS | JS heap |
|---|---|---|
| 4,892 | 60.2 | 73 MB |
| 20,000 | 59.2 | 98 MB |
| 60,000 | 58.9 | 82 MB |

Re-measured after the agent network, command bar and accessibility work. That
pass initially regressed 60k from 60.1 to **30.7 FPS**; three fixes recovered it:

1. Panels that derive from the whole book now read a **throttled** revision.
   Keying off the raw one rebuilt the lead list on every ingested event (~9/sec).
   Text a human reads does not need to update at 60Hz.
2. Telemetry is **incremental**. A stage change moves one lead between two
   buckets, so the counts carry forward instead of rescanning every lead.
3. The lead list selects its top 150 in **a single pass** instead of sorting the
   book. A full sort spends O(n log n) to discard 99.75% of its own output.

Vsync-capped, so these read as "never drops below 60" rather than a ceiling.
Override the book size with `?leads=N` to probe further.

> **These numbers could not be reproduced on 2026-09-15 and should be treated as
> unverified until re-measured on a machine with a working GPU path.** In the
> current environment the same probe reports ~2 FPS against the production build.
> That reading is not evidence of a regression: a *trivial* full-screen WebGL page
> — one triangle, a 16-iteration fragment shader, no Three.js — measures **4.1
> FPS** in the same browser, and Apsis at a quarter of the pixels measures 15.2.
> Frame rate tracks pixel count and is indifferent to lead count (4,892 / 20,000 /
> 60,000 all land within noise of each other), which is the signature of a
> fill-rate-bound software rasterizer, not of application work. With WebGL
> disabled entirely the app holds 59.6 FPS, so the React, state and event layers
> are not implicated either way.
>
> The honest summary: this environment can measure that the CPU-side pipeline is
> free, and cannot measure the GPU-side claim at all. Re-run on real hardware
> before quoting the table above.

What buys the headroom: one draw call for the whole field, zero allocation in the
frame loop, the full lead walk skipped on any frame where no score changed, a
constant bounding sphere so picking never recomputes one, and an O(1) leadId →
index map so per-frame lookups never scan.

## Accessibility (§21)

The canvas is marked `aria-hidden`. That is the design, not an omission: a canvas
has no structure to expose, so bolting ARIA onto it announces an unlabelled
graphic. Instead the same information is published as real DOM.

- **`src/ui/LeadList.tsx` is the Universe in text** — same source of truth, same
  ordering by approach to periapsis, same selection. A `role="listbox"` with
  `aria-activedescendant`; arrow keys move, Enter pins, Escape clears. Selecting
  here moves the marker in the 3D field and vice versa.
- **Keyboard camera** — arrows orbit, `+`/`−` zoom, held keys integrated against
  frame delta so movement is smooth and ignores OS key-repeat delay. Suppressed
  while a text field or the listbox has focus.
- **Non-visual status** — a polite live region announces booked count, leads near
  booking, and in-flight agent tasks. Deliberately NOT wired to the raw event
  feed: at ~9 events/sec that is unusable chatter. It announces on a slow cadence,
  only when a figure actually changed, and only after the system has settled —
  announcing at mount would say "0 agent tasks" and hold it for a full interval.
  Selection gets its own assertive region so it is spoken at once.
- **Reduced motion** — subscribed live, not sampled at mount. Removes motion that
  carries no information (field rotation, Core breathing, node pulse) and shortens
  score-driven travel rather than removing it, since a lead still has to be *seen*
  relocating or the field stops explaining itself.
- Focus rings via `:focus-visible`, a `prefers-contrast: more` block, and every
  control labelled (verified: zero unlabelled buttons or inputs).

## Responsive (§22)

Verified at 1600/1000/760/420px wide: no horizontal overflow at any width and the
command bar stays inside the viewport. Below 820px the layout stacks — field on
top at a fixed 46vh, rail scrolling beneath.

## Model Orchestrator (§30-40)

Routes project phases to the model best suited to them, and is honest about
whether it can actually perform the switch.

`src/orchestrator/registry.ts` is the file where this feature usually starts
lying. The tempting implementation hardcodes a model list from documentation and
reports it as available; §37.1 forbids that and §32 says so outright. So the
profiles here describe only what each model is **good at** — they assert nothing
about reachability. Reachability comes from a descriptor the host declares:

```js
window.__APSIS_MODEL_ENV__ = {
  activeModel: 'opus',              // what the user currently has selected
  selectableModels: ['fable'],      // what they could switch to by hand
  programmaticModels: [],           // what this build can invoke with no human
}
```

Absent that descriptor every model is `unavailable`, mode is `ASSISTED`, and the
panel **blocks rather than inventing a routing plan**. A browser bundle genuinely
cannot discover which models an account may invoke; admitting that is the correct
behaviour, not a gap.

Three states, all verified end-to-end:

| Environment | Mode | Behaviour |
|---|---|---|
| nothing declared | ASSISTED | blocked; no plan invented |
| `activeModel: opus`, `selectable: [fable]` | ASSISTED | routes to Fable, emits *ACTION REQUIRED: switch to FABLE*, marks visual phases `manual` |
| `programmatic: [fable]` | **ON** | routes to Fable and executes; no user action |

Two structural honesty guarantees:

- **`requiresUserSwitch` distinguishes "on it" from "could move to it".** An
  earlier version collapsed those and emitted *"ACTION REQUIRED: switch to OPUS"*
  while Opus was already the active model.
- **A routing decision never marks itself executed.** `RoutingLogEntry.execution`
  starts `'pending'` and only `confirmExecution()` advances it, so §37.2 ("never
  claim a model was used unless it actually was") is enforced by structure rather
  than by discipline.

`handoff.ts` carries every field §34 requires across a switch, and
`missingFromHandoff()` reports any that are empty — so an incomplete handoff is
caught before delivery rather than discovered after.

## Degradation

The canvas is not load-bearing. With WebGL unavailable (`--disable-webgl`,
enterprise policy, GPU blocklist, remote desktop) the app keeps all 4,892 leads,
150 keyboard-navigable rows, the command bar and every panel, and renders a
labelled explanation in place of the 3D. Verified both ways; zero console errors
in either.

The boundary deliberately sits OUTSIDE the `aria-hidden` canvas wrapper — the
canvas is decorative, but a message explaining why it is missing is not, and
inside the wrapper it would be unreachable to a screen reader.

See `SELF-CRITIQUE.md` for the §28 audit, including what still fails.

## Status

Landed: lead gravity model, scoring and decay, event pipeline, store and
telemetry, the 3D Lead Universe, the Intelligence Core, stage rings, live
activity feed, picking (hover + click), the lead detail view, and the agent
network — task queue, claims, live arcs, and a roster derived from the same task
set the arcs are drawn from.

Also landed: the command interface (§13) — parse, show what was understood and
what was ignored, run against the book with a funnel, highlight the matched set
in the Universe, and dispatch real agent tasks for an action verb.

The parser is a real grammar over the domain's own vocabulary, not an LLM. That
is a deliberate staging choice, not a stub: swapping in a model means replacing
`parseCommand` with a call that returns the same `LeadQuery`. Execution, the
funnel, the highlight and the dispatch are unaffected — and unlike an LLM, this
runs with no API key, no latency and no per-command cost.

Also landed: the accessibility pass (§21) and responsive behaviour (§22), both
described above.

Also landed: the appointment centre (§16) and the visual phase — bloom
post-processing, motion trails derived from real score-driven travel, and a
raymarched volumetric Intelligence Core (executed by Fable 5 via the orchestrator's
delegated-routing path). `?fx=off` disables the post pipeline as a performance mode.

Also landed: **cluster / zoom (§15)** and the **active skills visualization (§12)**,
both of which earlier revisions of this file and `SELF-CRITIQUE.md` listed as
unbuilt. They are real now — see below.

**Cluster / zoom (§15).** `src/universe/clusters.ts` is a pure, testable registry
of grouping dimensions; `DRILL_SEQUENCE` is the default order Universe → region →
state → city → segment, and the individual level is the selection the store
already had.
Drilling does **not** regroup the field. Score is the only thing that moves a
lead (§27 rule 3), so herding cluster members into a huddle would be exactly the
decorative movement the prompt forbids. Instead the drilled set stays at full
luminance, everything outside it recedes to the same 0.13 dim the command bar
uses for non-matches, and the camera performs the framing move. The shape of the
whole book stays legible; the cluster is the part still lit. The breadcrumb says
so out loud — *"rest of the book recedes, not removed"*.

The breadcrumb and cluster chips are real DOM portalled out of the `aria-hidden`
canvas wrapper into `.stage`, so the drill is keyboard-reachable and
screen-reader-visible rather than canvas paint. Escape backs out one level at a
time (selection first, since it is the deepest thing on screen) and yields to
text fields and the listbox, which have their own Escape semantics.

**Active skills (§12).** `src/universe/skills.ts` derives the panel from live
agent tasks and the event feed — never from a static list of what the product can
do, which is what §12 forbids and the easiest thing to ship by accident.
COMPLETE and ERROR entries expire by wall clock, so the panel answers "what is
Apsis doing *right now*" rather than "what has Apsis ever done".

Not yet built: a real backend/CRM behind `src/state/source.ts`, persistence, and
the task-decomposition half of §38.
