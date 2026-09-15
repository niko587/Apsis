# Project Master Plan

_Last updated: 2026-09-15._ The authoritative requirements document is
`APSIS_MASTER_BUILD_PROMPT.md` (in `~/Downloads/APSIS_Master_Build_Package/`,
outside this repo). This file maps its phases (§25) to reality and states the
remaining arcs in priority order.

## Spec phases (§25) — status

| Phase | Scope | Status |
|---|---|---|
| 1 Architecture | inspect, map, sequence | **Done** (docs are the living map) |
| 2 Visual system | tokens, shell, hierarchy, command UI, telemetry | **Done** (tokens informal — see arc C) |
| 3 3D Intelligence Core | procedural core, shaders, state-reactive | **Done** (glitch-fixed; §8's full state vocabulary partial) |
| 4 Lead Universe | nodes, zones, gravity, movement, clusters, zoom | **Done** |
| 5 Real event integration | events, skills, agents, command exec, telemetry | **Done above the transport seam** (source is simulated — arc A) |
| 6 Agent/skill visualization | agent nodes, skill nodes, connections | **Done** |
| 7 Appointment centre | calendar/appointment state | **Done** (in-app records; no external calendar) |
| 8 Lead detail / clusters | data flow + transitions | **Mostly done** (individual level still panel-resolved — arc C) |
| 9 Performance / accessibility | profile, fix, a11y, responsive | **Done for a11y/responsive; perf UNVERIFIED on real GPU** (arc D) |
| 10 Final visual polish | vs reference images | **Not started as a dedicated pass** |

## Remaining arcs, in order

### Arc A — Real data boundary (the single largest gap)
Everything above `src/state/source.ts` is real; nothing below it exists.
1. Define the transport contract at the seam (connect/disconnect, event
   stream, backpressure, error surface) — keep `LeadEvent` as the wire type.
2. Event translation layer for CRM-style namespaced events (§18 divergence).
3. Persistence: first as local snapshot/rehydrate, then real storage.
4. A second concrete source implementation (e.g. recorded-session replay
   file) to prove the seam actually swaps.

### Arc B — Intelligence
1. LLM `parseCommand` behind the same `LeadQuery` contract (opt-in when a
   key/mechanism exists; grammar remains the zero-cost fallback).
2. §38 task decomposition: understand → decompose → skills → model → verify,
   feeding the existing router.
3. Programmatic model invocation (§30 layer 6) if/when the host environment
   provides a mechanism — never faked before then (§37).

### Arc C — Product depth
1. Remaining §15 dimensions: campaign, source, agent, intent, timeframe
   (requires seed/domain fields for campaign + source).
2. §14 spatial individual transition (lead resolves in-field, panel becomes
   secondary).
3. §24 design tokens formalized (single token source consumed by CSS and 3D
   colour constants).
4. §10 per-move score breakdowns ("+8 reply, +5 qualified need") surfaced.
5. §25 phase 10: dedicated polish pass against the two reference PNGs.

### Arc D — Verification & operations
1. Real-GPU performance pass (§20): re-measure the FPS table on actual
   hardware; keep or revise README claims. **User-machine task.**
2. GitHub as canonical source of truth: remote, push, then CI running
   `tsc -b`, `vitest run`, `oxlint`, `vite build` on every push.
3. Visual regression harness for the Universe (screenshot diffs at fixed
   seed/camera).

## Non-goals (standing)
- No merging with, renaming to, or importing from **Cortex** (separate
  project, out of scope, read-only).
- No fake demo behaviours: no timer-driven movement, no invented backend
  responses, no pretended model switches (§27, §37).
- No separate CRM app; Apsis is the operating layer.

## Working practice
Opus for architecture/domain/integration; Fable for 3D/GLSL/visual phases
(spec §2); manual model switching by the owner; handoffs through
`/docs` (see `AI_DEVELOPMENT_PROTOCOL.md`), never through chat memory.
