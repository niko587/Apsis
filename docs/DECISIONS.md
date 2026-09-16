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
