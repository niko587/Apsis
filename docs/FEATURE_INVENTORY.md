# Feature Inventory

_Last updated: 2026-09-15. Status vocabulary:_
**Real** = implemented, driven by actual application state, verified.
**Partial** = implemented but missing a stated part of its spec section.
**Simulated** = implemented seam with fabricated data behind it, by design.
**Missing** = not built.

| Feature | Spec § | Status | Where / notes |
|---|---|---|---|
| Lead gravity scoring + decay | §4 | Real | `domain/scoring.ts`, `gravity.ts`. Configurable weights; decay after 72h; `TOUCH_CEILING` 98 — only a booking reaches centre. |
| 3D Lead Universe (instanced field, rings, trails, picking) | §7 | Real | `universe/LeadField.tsx`. One draw call; trails derived from real travel. |
| Intelligence Core (raymarched volume, load-reactive) | §8 | Real | `universe/Core.tsx`. Intensity = live event rate. Glitch-fixed 2026-09-15 (D15). All §8 named states beyond IDLE/PROCESSING (skill-active, tool-executing energy travel) are **not** distinct visual states — partial against the full state list. |
| Leads as visual entities by stage | §9 | Real | Size/brightness/colour by stage; booked resolve to centre. No avatars/photos (seed data has none). |
| Score-driven movement, no teleport, no timers | §10, §27.3 | Real | Structural: no `setScore`/`moveLead` exists. Movement reasons appear in feed, not yet as per-move "+8 reply" breakdowns — minor partial. |
| AI agents (roster, tasks, claims, arcs) | §11 | Real | `domain/agents.ts`, `universe/AgentNetwork.tsx`. 7 agents; task lifetimes; per-lead claims; unreachable-agent regression test. |
| Active Skills panel (only live states shown) | §12 | Real | `universe/skills.ts` + overlay. Derived from tasks/feed; COMPLETE/ERROR expire by wall clock. |
| Command interface (parse → understood → funnel → execute → visualize) | §13 | Real (grammar) | `domain/query.ts`, `ui/CommandBar.tsx`. Deliberately **not** an LLM; surfaces unparsed words; swapping in a model = replace `parseCommand`, same `LeadQuery` out. |
| — nationwide geography in commands | §13 | Real | Cities longest-first, full state names, uppercase-only 2-letter codes. |
| Lead detail view | §14 | Partial | Rail panel carries all §14 content (identity→next action). Spatial approach exists via §15 camera; the individual level still resolves to a panel, not an in-field transition. |
| Cluster / zoom drill | §15 | Real (geo+segment) | region → state → city → segment; camera framing; dim-not-remove; scrollable chips. Campaign / source / agent / intent / timeframe dimensions **Missing** (registry is open; `temperature` exists unused as proof of shape). |
| Appointment centre | §16 | Real | `domain/appointments.ts`, `ui/AppointmentCentre.tsx`. Records with name/time/type/advisor/status; deterministic business-hour slots, ≥24h notice. |
| Live telemetry | §17 | Real | Incremental counts; throttled DOM cadence; nothing decorative. |
| Event architecture | §18 | Partial (divergent) | Flat `LeadEventKind` union instead of namespaced events. Same coverage; needs translation layer at a real CRM boundary. |
| Performance @60 FPS | §20 | **Unverified** | Techniques in place (see ARCHITECTURE). Historical measurements exist but did not reproduce in the sandbox (environment proven fill-rate-bound). Needs a real-GPU pass. |
| Accessibility | §21 | Real | Listbox universe, keyboard camera, live regions, reduced-motion (live-subscribed), focus-visible, zero unlabelled controls. |
| Responsive | §22 | Real | Verified 420–2560 px; stacks below 820; command bar never disappears. |
| Interaction rules (hover/select/trails/pulses) | §23 | Real (mostly) | Hover/select/trails/completion behaviours present; some §23 verbs (energy into Apsis on task start) are approximations. |
| Design system | §24 | Partial | CSS custom properties + consistent conventions in `App.css`/`overlay.css`; not a formalized token system; no component library layer. |
| Model Orchestrator | §30–40 | Real (ASSISTED) | Routing, capability profiles, env-descriptor reachability, handoff records, execution-confirmation honesty. **Programmatic multi-model invocation Missing** — environment provides no mechanism; correctly reports ASSISTED and blocks without descriptor. |
| Task decomposition ("Apsis decides") | §38 | Missing | The routing half exists; understanding→decompose→select does not. |
| Backend / CRM / transport | §19 | Simulated | `state/source.ts` fabricates events at ~9/s. Single-seam replacement point. |
| Persistence | — | Missing | Reload reseeds. Fine for demo, wrong for product. |
| GitHub / CI | — | Missing | No remote, no CI. Git history begins 2026-09-15 (see NEXT_ACTIONS 1). |

## Real vs mocked, in one paragraph

Everything above `src/state/source.ts` is real and test-covered: if the
simulated source were replaced tonight by a CRM webhook feed emitting the same
`LeadEvent` type, no other file would change and every panel, animation and
command would keep working. What is fabricated is the *events themselves* (and
therefore the leads' histories), the absence of persistence, and the command
parser being a grammar rather than a model — each a deliberate, documented
staging choice with a defined replacement seam.
