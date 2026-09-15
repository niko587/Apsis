# Decision Log

Numbered, append-only. Each entry: what was decided, why, and what it forbids.
Longer rationale usually lives as a comment at the decision's code site;
this file is the index an external reviewer can trust.

## D1 — Score is the only mover; `ingest()` is the only mutator
The store exposes no `setScore`/`moveLead`; the 3D layer re-derives position
from score every frame and holds no state. Forbids: tween systems, decorative
movement, arbitrary-timer progression (spec §27.3). This is the project's
load-bearing invariant.

## D2 — Radius from stage index, not raw score
Score bands are uneven (cold spans 20 points, booked 1). Equal annulus per
stage keeps every stage legible; within-stage progress shows as drift.

## D3 — Engagement asymptotes below booked (`TOUCH_CEILING` = 98)
No volume of replies can reach periapsis; only `appointment_booked` crosses
into the booked band. The centre means a booking or it means nothing.

## D4 — Negative movement is real
Objections/cancellations/going-cold push outward; idle decay after a 72h
grace. A one-way universe is a progress bar, not a pipeline.

## D5 — Agent work is a task with a lifetime and a claim
Outbound events come from `AgentTask`s that occupy an agent and claim the
lead (no double-working); inbound events land immediately. Arcs in the field
are those tasks, one-to-one.

## D6 — Command parser is a grammar that reports its leftovers
Unparsed words come back as `ignored:` chips; recognised spans are blanked as
consumed; recency parses before stages ("haven't been contacted in 14 days"
contains a stage word). Swapping in an LLM = replacing `parseCommand`, same
`LeadQuery` contract. Forbids: silently dropping clauses.

## D7 — The funnel is the answer
Every query reports per-clause survivor counts. Makes contradictory queries
self-explaining (`376 qualified → 0 score > 80`).

## D8 — Canvas is `aria-hidden`; information parity lives in DOM
`LeadList` is the Universe as a listbox; announcements on slow cadence; any
new visual information must also land in DOM. Forbids: ARIA bolted onto
canvas; DOM-less features.

## D9 — Orchestrator honesty is structural (spec §37)
Capability profiles never assert availability; reachability only from the
host descriptor; routing log entries start `execution:'pending'` until
`confirmExecution()`. Absent descriptor → ASSISTED and blocked, no invented
plan. Forbids: hardcoded model availability, claiming unexecuted routing.

## D10 — One shared `stableHash` with an avalanche finalizer
FNV-1a + murmur3 finalizer, shared by appointments and channel routing (both
read high bits). Fixed real distribution bugs; shared so a fix cannot fork.

## D11 — Stage bands tile the reals, `[lo, hi)`
Integer-inclusive bands left score 20.5 stageless and made radius
non-monotonic. Guarded by a 0.25-step test.

## D12 — The rail scrolls; every list owns a bounded band (2026-09-15)
`overflow:hidden` around nine panels silently amputated five of them,
including the accessible lead list — while every automated check stayed
green. Lesson recorded in `SELF-CRITIQUE.md`: **rendered is not reachable**;
UI work needs geometry+click verification in a real browser.

## D13 — The book is national and population-weighted (2026-09-15)
~90 metros, 50 states + DC, sampled by metro population; area codes belong to
their metro. A single-state book made the §15 drill's first level a no-op.
Guarded by tests: 4 regions present, >40 states, largest state >5× median,
one area code per metro.

## D14 — Geography parsing: uppercase-only state codes, longest-first cities
(2026-09-15) `ME/OR/IN/OK/HI/DE` are English words — case-insensitive
matching turns "find me leads" into a Maine filter. City scan longest-first
so "Kansas City" survives. Tests assert the *absence* of matches (the
direction that fails silently). Ambiguity rule: bare city name matches every
state using it (both Charlestons); "Washington" is the DC metro, `WA` the state.

## D15 — Core shader: dithered march, fixed noise frequency, periodic phases
(2026-09-15) Three glitch causes fixed structurally: (a) per-pixel IGN stagger
on the march start — undersampling banding becomes static grain; (b) noise
frequency decoupled from the breathing radius — the breath moves the
silhouette, never the pattern; (c) time arrives as wrapped phases over a
lattice with integer lacunarity and per-corner mod — seamless to float32
rounding (max seam delta 3.6e-6), so uptime cannot degrade it.
Also recorded: the original "hash precision" diagnosis was **disproven by
float32 emulation** before fixing — measure first, even when the story sounds
right. Forbids: raw elapsed seconds entering shader noise domains.

## D16 — Cluster chips scroll, never truncate (2026-09-15)
"…and N more" hid the very states a user drills for. Same class of failure
as D12.

## D17 — Docs-in-repo protocol (2026-09-15)
`/docs` is the canonical handoff surface; `CURRENT_STATE.md` and
`NEXT_ACTIONS.md` must be updated after every meaningful phase so an external
AI can resume without local conversation history. See
`AI_DEVELOPMENT_PROTOCOL.md`.

## D18 — Aggregate-then-assert for whole-book property tests (2026-09-15)
A 49k-`expect()` loop timed out under machine contention while the property
itself takes milliseconds. Whole-book invariants collect violations in plain
code and assert once (first 5 shown).

## D19 — GitHub over SSH; stub history merged, not overwritten (2026-09-15)
Two choices worth not re-litigating. **(a) SSH, not HTTPS.** The only git on
this machine is a standalone `dugite` build (no CLT, no system git, no `gh`),
and it ships **no CA bundle** and no `osxkeychain` credential helper — its own
shim comments flag HTTPS pushing as untested. An ed25519 key with the host
fingerprint pinned sidesteps both the trust store and credential storage. A
token would have needed `credential.helper store`, i.e. plaintext on disk, for
no gain. **(b) Merged, not force-pushed.** The remote already held 3 stub
commits (one-line `README.md`, two typo fixes of the project name). The stub
was read first, confirmed superseded by the repo's real 23KB README, and the
histories joined with `--allow-unrelated-histories`, resolving add/add in
favour of ours. Force-push would have lost nothing of value, but discarding
someone else's published commits is the owner's call, not the agent's, and the
merge is verified inert: `git diff cc8ca0b HEAD` is empty. Forbids: rewriting
published history on `main` without explicit owner instruction.
