# Self-critique (§28)

The master prompt asks these twelve questions after each major phase. Answered
honestly — a pass here means verified, not assumed.

| # | Question | Verdict |
|---|---|---|
| 1 | Does Apsis feel like the intelligence operating system? | Partly |
| 2 | Is the Lead Universe the visual centerpiece? | Yes |
| 3 | Do leads visibly move closer to the appointment target? | Yes |
| 4 | Is movement driven by real state? | Yes |
| 5 | Can I immediately see what agents are doing? | Yes |
| 6 | Can I immediately see active skills? | Yes |
| 7 | Does the Apsis core respond to real activity? | Yes |
| 8 | Does the command bar feel like the primary human interface? | Partly |
| 9 | Does the center clearly represent qualified booked appointments? | Yes |
| 10 | Does the system feel premium rather than gimmicky? | Yes |
| 11 | Does it perform at 60 FPS with realistic lead counts? | **Unverified** |
| 12 | Does it remain usable without the visual effects? | Yes |

## Where the passes are load-bearing

**4 — movement driven by real state.** Structural, not a promise. The store has
no `setScore` and no `moveLead`; `ingest(event)` is the only mutator. The
renderer holds no state and re-derives position from score every frame. The
motion trails are a derivative of actual travel — at rest the gap converges to
zero and nothing draws.

**11 — performance: downgraded to unverified.** The earlier entry claimed 60.2 /
59.2 / 58.9 FPS at 4,892 / 20,000 / 60,000 leads, measured rather than assumed.
On 2026-09-15 that did not reproduce: the same probe reads ~2 FPS against the
production build. The re-measurement does not show a regression either — a
trivial full-screen WebGL page (one triangle, 16-iteration fragment shader, no
Three.js) reads 4.1 FPS in the same browser, frame rate tracks pixel count and
ignores lead count, and with WebGL disabled the app holds 59.6 FPS. That is a
fill-rate-bound software rasterizer, and it cannot measure the claim in either
direction.

The verdict is therefore "unverified", not "yes" and not "no". A pass here is
supposed to mean *verified*, and a number that cannot currently be reproduced
does not clear that bar no matter how carefully it was taken at the time.

**12 — usable without the visual effects.** Verified by taking WebGL away
(`--disable-webgl`): the app keeps all 4,892 leads, 150 navigable rows, the
command bar and every panel, and shows a labelled explanation of why the 3D is
missing. Before the boundary existed it survived too — but with an uncaught
`THREE.WebGLRenderer` exception and a silent black rectangle, which is a product
that looks broken rather than degraded.

## The failures

**6 — active skills: now built.** §12 derives the panel from live agent tasks and
the event feed, with COMPLETE and ERROR entries expiring by wall clock. The
constraint that made it non-trivial was §12's own — *do not display all skills as
active* — and a static list of every skill the product has, which is the easiest
thing to ship by accident, is not what shipped.

**The one that should not have survived this long.** The rail was
`overflow: hidden` around more content than fits, so at 1600×1000 five of nine
panels were clipped away with no scrollbar: the agent roster, the temperature
legend, the Model Orchestrator, the live activity feed and the Leads list. Most
of §17's telemetry, and §21's accessible equivalent of the canvas, were simply
not on screen — and the Leads list was unclickable rather than merely awkward.

What makes it worth recording is that every check this project runs was green
while it was broken. Types passed, 80 tests passed, lint passed, the build
passed, and the §22 responsive audit passed too, because it asked whether
anything overflowed *horizontally* and nothing did. The self-critique above
answered "can I immediately see what agents are doing?" with a confident **Yes**
on the strength of the roster existing in the DOM. It existed. It was 186px below
the fold of a container that could not scroll.

The lesson is narrow and worth keeping: *rendered* is not *reachable*. A panel
that is present, correct and laid out can still be invisible and unclickable, and
no amount of unit testing will say so. The check that caught it was asking the
browser where each panel actually was and whether a click landed on it.

**1 — "intelligence operating system": partly.** Apsis observes and executes, but
it does not yet *decide*. §38 describes a system that, told "redesign the Lead
Universe", works out what needs to change, which skills apply, which model is
best, and what verification is required. The Model Orchestrator (§30-40) is the
routing half of that and is built; the task-decomposition half is not.

**8 — command bar: partly.** It parses a real grammar over the domain's own
vocabulary and reports what it could not place, which is better than a silent
LLM. But it is a grammar, not comprehension — phrasing outside its vocabulary is
honestly rejected rather than understood. Swapping in a model means replacing
`parseCommand` with a call returning the same `LeadQuery`; nothing downstream
changes.

## Honest gaps beyond the twelve

- **There is no backend and no CRM.** `src/state/source.ts` stands in for the
  real transport. This is the single largest gap between Apsis and a product:
  everything above it is real, and none of it is connected to real leads.
- **No persistence.** Reload resets the book to seed. Fine for a seeded demo,
  wrong for anything else.
- **The event vocabulary is flat.** §18 suggests a namespaced model
  (`lead.scored`, `call.connected`, `sms.replied`). `LeadEventKind` is a flat
  union that covers the same ground with less structure. Workable, but it will
  not map cleanly onto a real CRM's event names without a translation layer.
- **The design system is conventions, not tokens.** §24 asks for a system;
  `App.css` has CSS custom properties and consistent spacing, which is less.
- **Cluster / zoom (§15) is built.** Universe → state → city → segment → lead,
  as a camera move with the out-of-cluster book dimmed rather than removed.
- **Lead detail is still a side panel, though it is now reached spatially.** §14
  says "do not immediately open a generic side drawer if the existing design
  supports a spatial transition". Universe → Cluster → Individual now *is* a
  camera move (§15), so the approach is spatial; but the individual level still
  resolves into the rail panel rather than into the field. The panel carries
  everything §14 asks for — contact, demographics, coverage, preference, intent,
  stated needs, derived next best action, appointment — so this is now a
  presentation miss rather than a navigation one. Smaller than it was, not gone.
- **The §15 drill dimensions are still thinner than §15 asks for.** The book is
  national now (≈90 metros, 51 states, population-weighted) and the sequence is
  region → state → city → segment, so every level partitions something real.
  But campaign, source, agent, intent and timeframe — all named in §15 as
  candidate groupings — remain unimplemented. `DIMENSIONS` is an open registry
  and `temperature` sits in it unused to prove the shape is not geography-
  specific; adding the others is an entry plus a slot. The structure is right
  and still under-exercised.
