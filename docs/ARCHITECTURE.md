# Architecture

_Last updated: 2026-09-15. ~7,900 LOC TypeScript/TSX. Stack: Vite 8, React 19,
TypeScript 6, react-three-fiber 9 / three 0.186, zustand 5, vitest 5, oxlint._

## The one law

**Score is the only thing that moves a lead, and the 3D layer holds no state.**

```
LeadEvent → scoring.applyEvent → score → gravity.radiusFor → position
   ↑                                ↓
event source                 store (telemetry, legend, feed)
```

`ingest(event)` is the store's only mutator — there is no `setScore`, no
`moveLead`, no tween system. The renderer re-derives position from score every
frame; motion trails are a derivative of actual travel (at rest the gap
converges to zero and nothing draws). Any PR that adds a second mutator or
gives the 3D layer its own authoritative state is wrong by construction.

## Module map

| Module | LOC | Responsibility |
|---|---|---|
| `src/domain/types.ts` | — | `Lead`, `Stage`, `LeadEvent`. Stage bands `[lo,hi)`, half-open, tiling the reals. |
| `src/domain/scoring.ts` | — | Event → score. Pure, deterministic, no clock. Positive events damp to zero at `TOUCH_CEILING` (98): only `appointment_booked` reaches the centre. Decay after 72h grace. |
| `src/domain/gravity.ts` | — | Score → orbital radius (equal annulus per stage, not raw-score-proportional) and world position. |
| `src/domain/geography.ts` | — | National metro table: ~90 metros, 50 states + DC, census regions, real area codes, population weights, weighted `pickMetro` (binary search). |
| `src/domain/seed.ts` | — | Deterministic book (mulberry32 + FNV-1a/murmur3 `stableHash`). Reproducible down to phone numbers. |
| `src/domain/agents.ts` | — | Agent roster, task lifetimes, channel routing (stable hash of lead id → SMS vs email), reactivation routing. |
| `src/domain/query.ts` | — | Command grammar → `LeadQuery` → funnel execution. Reports *unparsed* words. Parse order is load-bearing (recency before stages; cities longest-first; state codes uppercase-only). |
| `src/domain/appointments.ts` | — | Appointment records (§16): deterministic slots, business-hours, ≥24h notice, advisors, status. |
| `src/domain/nextAction.ts` | — | Derived (never stored) next-best-action per lead. |
| `src/state/store.ts` | — | Zustand. `ingest` sole mutator; incremental telemetry; revision counters; non-reactive `readLeads`/`readIndexOf` for frame loops. |
| `src/state/source.ts` | — | **The adapter boundary.** Simulated event transport; the one file a real CRM integration replaces. |
| `src/state/drillStore.ts` | — | §15 drill path (application state, deliberately outside `src/universe/`). Immutable path array → reference-equality change detection. |
| `src/orchestrator/*` | 802 | §30–40. Capability registry (what models are *good at* only), env descriptor (`window.__APSIS_MODEL_ENV__`) for reachability, router, handoff records, routing log with `execution: 'pending'` until `confirmExecution()`. |
| `src/universe/Universe.tsx` | — | Canvas, bloom/tone-mapping post pipeline (`?fx=off` disables), OrbitControls (`makeDefault`). |
| `src/universe/LeadField.tsx` | — | The whole book as **one instanced draw call**. Zero allocation per frame; full walk skipped when no score changed; O(1) id→index. |
| `src/universe/Core.tsx` | — | Raymarched volumetric Intelligence Core; intensity = live event rate. Phase-driven periodic animation (see DECISIONS D15). |
| `src/universe/CameraRig.tsx` | — | §15 framing moves: centroid+spread of drilled set, exponential approach, hands camera back to user after settle. |
| `src/universe/AgentNetwork.tsx` | — | In-flight agent tasks as arcs, one-to-one. |
| `src/universe/clusters.ts` | — | Pure drill-dimension registry + `DRILL_SEQUENCE` (region → state → city → segment). Open: adding a dimension is one entry + one slot. |
| `src/universe/skills.ts` + `SkillRing.tsx` | — | §12 active skills derived from live tasks/feed; wall-clock expiry. |
| `src/universe/UniverseOverlay.tsx` | — | Breadcrumb + skills panel as real DOM, **portalled out of the aria-hidden canvas wrapper** into `.stage`. |
| `src/ui/*` | 1,166 | Rail panels (telemetry, appointments, roster, legend, lead list/detail, orchestrator, feed), command bar, announcers, boundary. |

(Per-directory LOC: domain 2,041 · state 615 · orchestrator 802 · ui 1,166 ·
universe 2,646.)

## The source contract (Arc A)

**`ingest(event)` is the only way an incoming event changes state.** Everything
below is about how events are *produced*; nothing below may reach past that
boundary.

```
SOURCE ──emits LeadEvent──▶ ingest ──▶ scoring ──▶ store ──▶ gravity ──▶ Universe
  │                                                      └──▶ rail panels
  ├── SimulatorSource   fabricates a plausible stage-aware stream (~9/s)
  └── ReplaySource      re-emits a recorded session at recorded timing
```

```ts
interface LeadSource {
  readonly name: string;   // diagnostics only — never branch on it
  start(): void;
  stop(): void;
}
```

Deliberately tiny. A source is anything that can be switched on, switched off
and identified; what it does while running is produce `LeadEvent`s. Nothing
above the seam knows which implementation is running — `src/state/sources.ts`
picks one from `?source=`, defaulting to the simulator.

| | transport-specific | domain |
|---|---|---|
| when an event happens | ✓ source | |
| which lead, which kind, which agent | | ✓ `LeadEvent` |
| what an event is *worth* | | ✓ `scoring.applyEvent` |
| where a lead sits | | ✓ `gravity.positionFor` |
| task lifecycle, retries, backpressure | ✓ source | |

### SimulatorSource (`src/state/source.ts`)

Fabricates stage-aware events at ~9/s. It does two things beyond emitting:
opens `AgentTask`s (which is what draws in-flight agent arcs, resolving into an
event through `completeTask` → `ingest`) and drives `applyDecay` on a slow
timer. **Both are transport-side simulation, not domain truth** — which is
precisely why a second source is not required to reproduce them.

### ReplaySource (`src/state/replay.ts`)

Emits a recorded session through the same `ingest`, preserving order and
relative timing, with an injectable scheduler so timing is testable without
sleeping. Knows nothing of zustand, React or Three.js. A single-timer chain, so
`stop()` has exactly one thing to cancel and emission after stop is impossible.

**What replay does not reproduce, stated plainly:** the transient agent arcs
that were in flight while recording, because tasks are not domain events. Each
replayed event still carries its original `agentId`, so attribution survives;
only the in-flight animation does not. Decay is a pure function of elapsed time
with a 72h grace period, so it is a no-op across any recordable session.

### Recording format (version 1)

```jsonc
{
  "version": 1,
  "name": "built-in demo",
  "recordedAt": 1700000000000,   // or null for an authored fixture
  "events": [
    { "offsetMs": 0, "event": { "id": "…", "leadId": "lead_0000",
                                "kind": "contacted", "at": 1700000000000,
                                "agentId": "agent_sms" } }
  ]
}
```

`offsetMs` is relative to the start of the recording, so a session replays at
any wall-clock time and any speed without rewriting the events; `event.at` stays
absolute because it is domain data that appointments are scheduled from.
`parseSession` validates untrusted data and **throws rather than dropping bad
entries** — a replay that silently skipped events would produce a plausible run
that does not match what was recorded, which is worse than a loud failure.

`createSessionRecorder` captures the canonical stream by observing the store's
feed rather than wrapping `ingest`, so it sees every event regardless of the
route it took and adds nothing that can mutate state.

### Plugging in a real CRM / dialer / webhook

Implement `LeadSource`, translate the wire payload into `LeadEvent`, call
`ingest`. That is the whole contract. Namespaced CRM event names
(`sms.replied`) need a translation layer at this boundary — see the §18
divergence below — and nothing above the seam changes.

## §15 drill dimensions — the complete registry

Eight dimensions, all conforming to one `ClusterDimension { id, label, keyFor,
labelFor, matches }`. `DRILL_SEQUENCE` (region → state → city → segment) is the
*default path*; the rest are registered and fully functional but not in it,
exactly as `temperature` already was. **Adding a dimension is a registry entry;
no UI switch statement exists to update.**

| dimension | key source | notes |
|---|---|---|
| region / state / city | `lead.location` + geography tables | the national drill |
| segment | `lead.segment` | what cover they need |
| **campaign** | `lead.campaign` | the marketing push that produced them |
| **source** | `lead.acquisitionSource` | how they were acquired |
| **agent** | `lead.ownerAgentId` | real attribution, see below |
| **timeframe** | `lead.lastEventAt` | recency, see below |
| temperature | `lead.stage` | proof the registry is not geography-shaped |

### campaign and acquisition source

Both are canonical `Lead` fields, generated in `seedLeads` from
`stableHash(id + salt)` — **not from the seeded `rand()` stream**. That choice is
load-bearing: consuming even one extra draw inside the seeding loop would shift
every subsequent lead's score, name, metro and angle, and a persisted event log
replayed onto that different book would describe different leads. Hashing the id
leaves every pre-existing value byte-identical, so Persistence v1 and the Arc A
fixture keep working with no migration (D24).

Distinct salts keep the two independent; a shared salt would make a lead's
campaign predict its source. Measured on the default book: campaign 26.5 / 20.7
/ 16.4 / 13.9 / 12.2 / 10.3 %, source 26.5 / 21.7 / 19.2 / 14.7 / 11.0 / 6.9 % —
weighted, with nothing dominating and nothing vanishing.

**The field is `acquisitionSource`, never `source`.** `LeadSource` is the runtime
transport that produces events; they are unrelated concepts that would otherwise
collide in every search.

### agent

Source of truth is `lead.ownerAgentId`, which `ingest` sets from the `agentId` of
the event that last touched the lead — real attribution, not a fabricated
assignment field. Leads nothing has worked yet are reported as **Unassigned**
rather than dropped. On a freshly seeded book that is *every* lead, so Agent
shows a single honest cluster until a session warms the book; inventing seeded
ownership to make the demo look richer would be inventing data the product does
not have.

### timeframe

Buckets `lead.lastEventAt` by age against a reference time: Today, Last 3 days,
Last 7 days, Last 30 days, Older. First matching bucket wins, so they are
mutually exclusive by construction and `Older` is total — including a
future-dated `lastEventAt` from clock skew, which lands in Today rather than
nowhere.

It is the one dimension that depends on *when you ask*, and `keyFor` takes no
clock — so `createTimeframeDimension(now)` captures the reference time. Production
registers it with `Date.now`; tests build one with a fixed clock, which is the
only way a bucket assertion can be deterministic rather than a function of when
the suite happened to run.

### The partition invariant

Every dimension must partition its parent: each lead in exactly one child, child
counts summing exactly to the parent, nothing dropped. `clusterChildren` skips a
null key, so a dimension that returns null for some leads would silently show a
book smaller than the one that exists — which is why no dimension returns null
and the suite asserts it across the whole 4,892-lead book.

## Persistence v1 (`src/state/persistence.ts`, `src/state/boot.ts`)

The saved file is **not** an alternate authoritative store. It is a durable copy
of the canonical event log, and restoring means replaying it through the same
`ingest` a live source uses:

```
saved log → validate → hydrate → ingest → scoring → store → gravity → UI
```

No second mutation mechanism exists; nothing in persistence writes a store field.

**Why this is even possible.** `seedLeads` derives every lead's score, stage,
theta and inclination from a pure `rng(seed)` stream, so a fresh book is
reproducible across reloads; only `createdAt`/`lastEventAt` shift with the
clock, and `applyEvent` depends on nothing but the prior score and the kind.
Replaying a saved log onto a freshly seeded book therefore reproduces scores and
stages exactly. Because the same log against a *different* book would land on
different leads, `{ seed, leadCount }` is recorded and checked on load.

**Storage: IndexedDB.** The simulator emits ~9 events/sec, so an hour is ~32,000
events — several megabytes. localStorage caps near 5MB and is synchronous on the
main thread, which this project spent seven rounds learning to keep clear. IDB
is async and roomy, so a write cannot jank a frame. It sits behind a
`SessionStore` interface (`load`/`save`/`clear`/`available`) with an in-memory
implementation used by tests, so the domain never imports a storage API.

**Format (version 1)**

```jsonc
{
  "version": 1,
  "savedAt": 1700000000000,
  "book": { "seed": 6241313, "leadCount": 4892 },
  "sealed": false,
  "events": [ { "offsetMs": 0, "event": { /* LeadEvent */ } } ]
}
```

Event validation is delegated to `parseSession`, so there is exactly one
definition of a well-formed log in the codebase.

**Boot order.** `bootSession()` is a module-level singleton promise: restore
fully, *then* start recording, *then* let `App` start a source. Two failures it
prevents — a source starting mid-hydration would interleave live events with
restored history and record the mixture; and React StrictMode's double-invoked
effects would otherwise hydrate the log twice, double-applying every event.

**Write policy.** Debounced (1.5s) and *chained, never concurrent* — two
in-flight writes could land in either order and leave a shorter log on top of a
longer one. `pagehide` forces a flush so a tab close does not lose the tail.

**Corruption policy — fail loudly, never plausibly.**

| condition | behaviour |
|---|---|
| empty storage | fresh seeded book (unchanged default) |
| unknown version | discard, clear the slot, start fresh, report |
| malformed record or any invalid event | discard, clear the slot, start fresh, report |
| book mismatch (`?leads=N` changed) | **do not apply**, **keep** the saved log, start fresh, report |
| storage unavailable or a write throws | app keeps running, durability off, reported in diagnostics |

Nothing is ever partially applied: a half-restored history is a believable
session that never happened, which is worse than starting clean and saying so.

**Cap.** At `MAX_PERSISTED_EVENTS` (50,000 ≈ 90 minutes) the log is **sealed**
rather than trimmed. A sealed log is a correct *prefix* of the session, so it
restores to a state the session genuinely passed through; dropping the oldest
events would restore a state it never had.

**Restored:** lead scores, stages, positions (derived from score), the
appointment ledger, booked count, feed history (last 200), agent attribution
carried on each event, telemetry. **Not restored, by design:** in-flight
`AgentTask` arcs (transport-side simulation, not domain events), camera, drill
path, selection, command state, and diagnostics.

**Source interaction.** `/` and `?source=sim` restore then continue recording.
`?source=replay` is **isolated** — it neither reads nor writes the persisted
session, so the demo fixture can never overwrite a real book.

## Event architecture

`LeadEventKind` is a **flat union** (replied, opened, contacted,
call_connected, objection, appointment_booked, went_cold, …). This diverges
from spec §18's namespaced suggestion (`lead.scored`, `sms.replied`); it covers
the same ground with less structure and will need a translation layer at the
CRM boundary. Outbound events are produced by `AgentTask`s (which claim the
lead — two agents cannot work the same person); inbound events land
immediately. The 3D layer subscribes to the same store as the panels — there
is no separate visualization state.

## Accessibility architecture (§21)

The canvas is `aria-hidden` **by design**; the same information is published
as real DOM: `LeadList` is the Universe as a `role="listbox"` (same ordering,
same selection, bidirectionally synced with the 3D field), status via slow-
cadence live regions, keyboard camera on arrows/+/−. Rule: any new visual
information must also land in DOM somewhere.

## Degradation

The canvas is not load-bearing. With WebGL unavailable the full app (all
panels, list, command bar) keeps working behind a labelled explanation
(`UniverseBoundary`), which sits *outside* the aria-hidden wrapper on purpose.

## Model Orchestrator (§30–40) — honesty by structure

- Profiles assert only competence, never availability (§37.1).
- Reachability comes exclusively from a host-declared
  `window.__APSIS_MODEL_ENV__ { activeModel, selectableModels, programmaticModels }`.
- Absent descriptor → every model `unavailable`, mode ASSISTED, panel blocks
  rather than inventing a plan.
- `RoutingLogEntry.execution` starts `'pending'`; only `confirmExecution()`
  advances it (§37.2 enforced by types, not discipline).
- `handoff.ts` carries every §34 field; `missingFromHandoff()` catches
  incomplete handoffs before delivery.

## Rendering performance techniques

One draw call for the field; zero allocation in frame loops (preallocated
scratch vectors everywhere); constant bounding sphere so picking never
recomputes; throttled revision for DOM panels (text does not need 60 Hz);
incremental telemetry (stage change moves one lead between buckets);
single-pass top-150 selection instead of sorting the book; point size scaled
by viewport height; camera framing computed once per drill change, never per
frame.
