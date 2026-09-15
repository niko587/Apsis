# Project Context

_Last updated: 2026-09-15_

## What Apsis is

Apsis is an AI Sales Operating System whose primary surface is a living 3D
**Lead Universe**. An *apsis* is a point of extreme approach on an orbit:
**apoapsis** the farthest, **periapsis** the nearest. A cold lead sits at
apoapsis on the outer rim; a qualified booked appointment is periapsis at the
centre. The product is the journey along that line, and the naming convention
throughout the code follows the metaphor — orbits, gravity, infall, capture.

The domain is **health-insurance sales**: segments like Family Coverage /
Medicare / Self-Employed, advisors, appointment types like "Family plan review".

## Identity — read this first

**Apsis is NOT Cortex.** Cortex is a separate, unrelated project belonging to
the same user, living at `~/Downloads/cortex`. Do not rename Apsis to Cortex,
do not merge them, do not import Cortex architecture, and treat that directory
as read-only and out of scope. The word "cortex" may legitimately appear only
in its anatomical sense if brain imagery is ever discussed — it never refers to
the other product.

## Where things live

| Path | What it is |
|---|---|
| `~/Downloads/apsis` | **The codebase.** This repository. |
| `~/Downloads/APSIS_Master_Build_Package/APSIS_MASTER_BUILD_PROMPT.md` | The authoritative spec. All `§n` references in code comments and docs point into it. |
| `~/Downloads/APSIS_Master_Build_Package/*.png` | Two visual design references (hierarchy/composition guides, not pixel-perfect assets). |

Local AI sessions are launched from the spec package directory, not the repo —
searches scoped to the working directory find no code. `cd` to the repo.

## A deliberate divergence from the spec

The spec's preamble describes Apsis as evolving an "existing Electron desktop
shell" with an `app://apsis` origin and a `window.apsis` IPC bridge. **The
actual repository is a fresh Vite + React 19 + TypeScript web app** — there is
no Electron anywhere, no `renderer/brain.js`, no prior shell. The spec's
*product* requirements (§3–§40) are being implemented faithfully; its account
of the starting codebase simply does not match reality and was treated as
context, not instruction. Docs here describe what exists.

## Model / work-mode strategy (spec §2)

Two Claude models collaborate on this project by manual switching:

- **Opus** — architecture, domain/state/event design, integration, debugging,
  data modelling, test design.
- **Fable** — Three.js / R3F, GLSL, particles, animation choreography, visual
  polish.

The human switches models in their Claude Code session (`/model`). Handoffs are
carried by these docs; never claim a model switch happened when it did not
(spec §37). The Model Orchestrator *inside the product* (spec §30–40) is a
separate thing from this working practice — see `ARCHITECTURE.md`.

## Environment gotchas (this specific machine)

- `node` (v22) exists only at `/usr/local/bin/node` — prepend to `PATH` or
  `npx` is "command not found".
- **There is still no system git and no `gh`** (Xcode Command Line Tools absent
  and uninstallable here). The working `git` is a standalone `dugite` build
  behind `~/.npm-global/bin/git`; the remote is SSH-only. See
  `CURRENT_STATE.md` → "Git / GitHub state" and D19.
- `package.json` now has `test`, `typecheck`, `test:e2e` and `check` scripts;
  `npm run check` runs the same five gates as CI.
- The machine is intermittently heavily contended (vitest module transforms
  observed at 165s vs a normal 66ms). Long commands should be run detached
  with output to a log; a test timeout under load is not necessarily a failure.
- Headless browser rendering here is **software-rasterized** — never trust FPS
  measured in it (a trivial one-triangle WebGL page measures ~4 FPS).
