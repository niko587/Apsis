# Apsis Autopilot

**GPT plans and reviews. Claude Code writes the code. Autopilot runs the tests
and enforces the boundaries. You approve the merge.**

It is a local developer tool. It is not part of Apsis, it never reaches the
browser, and the product cannot tell it is here.

```
  owner  ──▶  GPT-6 Astra  ──▶  Autopilot  ──▶  Claude Code
              plan / review      controller      implement
                    ▲                 │
                    └──── gates ◀─────┘
                                      │
                            TASK READY FOR OWNER APPROVAL
```

## What actually happens in a run

1. **Preflight.** Refuses to start if the working tree is dirty — otherwise
   "what did the worker change" has no answer.
2. **Plan.** One bounded TaskSpec from GPT-6 Astra, structured-output only,
   validated again locally.
3. **Isolate.** A new branch and a new git worktree under `.apsis-autopilot/`.
   Your main checkout is never the working surface.
4. **Implement.** Claude Code runs non-interactively in that worktree, with
   Read/Edit/Write/Glob/Grep and **no Bash**. It does not commit, branch, or
   push — the controller owns git.
5. **Boundary check #1.** The controller compares the *actual* diff against the
   task's allowed and forbidden files. A violation ends the task; no reviewer is
   consulted.
6. **Gates.** The controller runs typecheck / lint / unit / build / e2e itself.
   "Claude says the tests pass" is a sentence, not evidence.
7. **Boundary check #2.** Gates *run code*, and code writes files. The surface
   is re-checked after them, so a file that appeared during a build cannot ride
   into the commit unexamined.
8. **Review.** GPT-6 Astra reads a diff that is already gated and already
   bounded — with **every new file inlined in full** — looking for what gates
   cannot see: a weakened test, an assertion that passes for the wrong reason, a
   broken invariant. Anything that could not be read as text (binary, oversized)
   escalates rather than being described as reviewed.
9. **Repair,** up to 3 times, then stop.
10. **Boundary check #3, immediately before the commit,** plus a check that the
    surface is the same one the reviewer read.
11. **Stop at approval.** It prints the merge command. It does not run it.

## Setup

**1. Have Claude Code installed and logged in.** You already do — this is the
same `claude` you use in the terminal.

```sh
claude --version
```

**2. Create an OpenAI API key** at platform.openai.com, in your own account.

**3. Export it in your shell.** Locally, on your machine, and nowhere else:

```sh
export OPENAI_API_KEY=...
export APSIS_AUTOPILOT_WORKER_BUDGET_USD=5   # required for a real run
```

**The budget has no default and a real `run` refuses to start without it.** It
becomes `claude --max-budget-usd` and is the only hard ceiling on worker spend —
the loop count bounds how many turns happen, not what a turn costs. There is no
invented default because nobody here knows what a task of unknown size costs on
your plan: pick a number you would be relaxed about losing on a run that goes
wrong, watch a few runs, then raise it deliberately. `plan` and `dry-run` never
need it, because they never invoke a worker.

Or put it in `.env.autopilot` at the repository root — that file is gitignored.
Copy `tools/autopilot/.env.example` for the variable names.

> **Never paste an API key into a chat** — not into Claude Code, not into
> ChatGPT, not into an issue. Never commit one. The tool reads it from your
> environment and never writes it anywhere.

> **Billing note:** a ChatGPT subscription and OpenAI API usage are **separate
> things**. Your ChatGPT Plus/Pro subscription does not pay for API calls, and
> API calls do not come out of it. An API key bills your OpenAI platform account
> per token. Set a spend limit on the platform account before you start.

**4. Check the setup:**

```sh
npm run autopilot -- doctor
```

Add `--check-openai` to verify the key and model too. That does a metadata read
(`GET /v1/models/<id>`) and generates no tokens — but it is opt-in anyway, so
that the ordinary `doctor` never costs anything.

**5. See what it would plan, without doing anything:**

```sh
npm run autopilot -- plan --goal "finish prototype polish"
```

This calls GPT once and prints a TaskSpec. No branch, no worktree, no worker.

**6. See the whole run, inert:**

```sh
npm run autopilot -- dry-run --goal "finish prototype polish"
```

**7. The first real run:**

```sh
npm run autopilot -- run --goal "finish prototype polish"
```

Watch it. The first one is for finding out whether you agree with how it
behaves, not for getting work done.

## Commands

| Command | What it does | What it touches |
|---|---|---|
| `doctor` | Checks Node, git, tree, Claude CLI, key presence, runtime dir | nothing |
| `doctor --check-openai` | Also verifies the key and the model | one metadata GET |
| `plan --goal "…"` | One TaskSpec, printed and saved | one GPT call |
| `dry-run --goal "…"` | Shows the branch, worktree, gates and worker it *would* use | one GPT call |
| `run --goal "…"` | The full loop | branch + worktree + worker + gates + review |
| `run … --push-branch` | Also pushes the task branch | `git push origin autopilot/…` |

The goal can also come from `.autopilot-goal` at the repository root, or from
`--goal-file <path>`. The default is in `AUTOPILOT_POLICY.md`.

## Configuration

All of it is environment, all of it is local, none of it is `VITE_`-prefixed.

| Variable | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | — | required for `plan`, `dry-run`, `run` |
| `OPENAI_AUTOPILOT_MODEL` | `gpt-6-astra` | planner and reviewer model |
| `OPENAI_AUTOPILOT_REASONING_EFFORT` | `high` | `low` \| `medium` \| `high` |
| `APSIS_AUTOPILOT_CLAUDE_MODEL` | `claude-opus-5` | default worker; a task may pick `claude-fable-5` |
| `APSIS_AUTOPILOT_CLAUDE_BIN` | `claude` | path to the CLI |
| `APSIS_AUTOPILOT_WORKER_BUDGET_USD` | **none — required for `run`** | `claude --max-budget-usd` |
| `APSIS_AUTOPILOT_PASS_ANTHROPIC_KEY` | unset | see "the worker's environment" below |
| `APSIS_AUTOPILOT_MAX_REPAIRS` | `3` | clamped to 3 |

## Limits, on purpose

Per invocation: **1 task**, **1 planning call**, **3 repair cycles**, **1 review
call per iteration**. There is no infinite loop, and `--max-tasks` above 1 is
deliberately not wired up yet — the architecture supports it, and raising it
should follow from trusting the tool, not precede it.

## The worker's environment, and its tools

**The worker does not get your credentials.** Both child processes — the Claude
worker and every gate — are spawned with a sanitized environment: every
secret-shaped variable name is removed, then every credential-shaped *value*,
then anything byte-identical to one of this process's own secrets. `PATH`,
`HOME`, `SSH_AUTH_SOCK` and the ordinary build environment survive, because a
gate still has to run.

`OPENAI_API_KEY` is the controller's and the controller's alone. Handing one
provider's key to the other provider's process would dissolve the separation
this whole tool is built around, and it was happening purely by inheritance.

v1 assumes Claude Code is authenticated the normal way — the stored login you
already use. If your installation instead needs `ANTHROPIC_API_KEY` from the
environment, set `APSIS_AUTOPILOT_PASS_ANTHROPIC_KEY=1`; that re-admits **that
one variable and nothing else**.

**The worker has no shell.** Its tools are `Read, Edit, Write, Glob, Grep`;
`Bash`, `WebFetch`, `WebSearch` and `Task` are denied, MCP servers are disabled,
and only *project* settings are loaded — so a `Bash(git *)` allowance in your
personal Claude settings grants the worker nothing.

**The limitation that comes with that:** the worker cannot run a single test in
a tight loop while it works. It has to reason from the code, and it learns what
failed only on a repair turn, from the controller's real gate output. That costs
worker efficiency. It buys the ability to say plainly that the coding agent
cannot execute arbitrary commands — worth more before a first unattended run.

## What this is NOT: an OS sandbox

Worth being blunt, because the list below reads reassuringly and could be
mistaken for isolation.

**The gates execute repository code.** `npm test` runs a test file that a model
may have just written; `npm run build` runs a build config. That code runs as
you, on your machine, with filesystem and network access. Stripping credentials
from its environment reduces what it can reach. It does not stop it running.

**The worker can write any file inside its worktree.** The boundary check
catches it afterwards — that is detection, not prevention. An out-of-bounds file
is never committed, but it was written.

So v1 is **for supervised use on a repository you trust**. Watch the first runs.
Read the diffs. Leaving it running unattended needs a real execution sandbox or
an isolated runner first, and that is separate work that has not been done.

## Safety model

The prompt asks the worker to behave. The *controller* is what makes it safe:

- **Gates are a table, not a string.** A TaskSpec names gates from a closed
  enum; only `gates.mjs` turns a name into a command, and commands are literal
  argument arrays. An arbitrary shell command is not a gate that fails — it is a
  value that cannot be expressed.
- **The boundary is checked against the real diff,** including untracked files,
  **three times** — after the worker, after the gates (which run code and can
  write files), and immediately before `git add -A`. A violation is a controller
  verdict the reviewer cannot waive. The committed surface is also checked to be
  the same set the reviewer actually read.
- **The reviewer sees new files in full.** New files used to appear as
  `(new file, contents not inlined)`, so a task whose whole implementation was
  one new module could be "reviewed" unread. Anything that cannot be inlined —
  binary, or over the byte budget — is named explicitly and escalates the task.
- **Secrets never enter a prompt.** The packet builder reads an allow-list of
  files; `assertNoSecrets` runs on the **raw** text and aborts the run, because
  scrubbing first would make the check inspect text the secret had already been
  removed from — which is exactly the bug it had. Shape redaction happens after
  the abort check, as defence in depth.
- **No credential reaches a child process,** worker or gate.
- **Run records are redacted twice** — by shape and by the exact values of this
  process's own secret-shaped environment variables.
- **git is a short list.** No force push, no reset, no rebase, no branch delete.
  Absent, not guarded.
- **Nothing merges.** v1 ends at owner approval, and `--push-branch` refuses any
  branch outside `autopilot/`.

See `AUTOPILOT_POLICY.md` for the scope rules and the four facts no model
verdict can override.

## Tests

```sh
npm run autopilot:test
```

It also runs in CI, on every push and pull request, before the browser suite.

Every test runs with **no OpenAI credential, no Anthropic credential, no network
and no live Claude invocation**, using fake adapters. A test suite that costs
money is a test suite that stops being run — and these are exactly the checks
that must survive every change.

## What Autopilot is not

It is not a merge bot, it is not a CI system, and it is not a substitute for
reading the diff. It is a way to let two models do a bounded piece of work
against a boundary that a human wrote, and to stop cleanly when it does not go
well.
