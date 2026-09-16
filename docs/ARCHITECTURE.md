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
