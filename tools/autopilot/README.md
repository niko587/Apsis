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
4. **Implement.** Claude Code runs non-interactively in that worktree. It does
   not commit, branch, or push — the controller owns git.
5. **Boundary check.** The controller compares the *actual* diff against the
   task's allowed and forbidden files. A violation ends the task; no reviewer is
   consulted.
6. **Gates.** The controller runs typecheck / lint / unit / build / e2e itself.
   "Claude says the tests pass" is a sentence, not evidence.
7. **Review.** GPT-6 Astra reads a diff that is already gated and already
   bounded, looking for what gates cannot see — a weakened test, an assertion
   that passes for the wrong reason, a broken invariant.
8. **Repair,** up to 3 times, then stop.
9. **Stop at approval.** It prints the merge command. It does not run it.

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
```

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
| `APSIS_AUTOPILOT_WORKER_BUDGET_USD` | unset | passed to `claude --max-budget-usd` |
| `APSIS_AUTOPILOT_MAX_REPAIRS` | `3` | clamped to 3 |

## Limits, on purpose

Per invocation: **1 task**, **1 planning call**, **3 repair cycles**, **1 review
call per iteration**. There is no infinite loop, and `--max-tasks` above 1 is
deliberately not wired up yet — the architecture supports it, and raising it
should follow from trusting the tool, not precede it.

## Safety model

The prompt asks the worker to behave. The *controller* is what makes it safe:

- **Gates are a table, not a string.** A TaskSpec names gates from a closed
  enum; only `gates.mjs` turns a name into a command, and commands are literal
  argument arrays. An arbitrary shell command is not a gate that fails — it is a
  value that cannot be expressed.
- **The boundary is checked against the real diff,** including untracked files,
  and a violation is a controller verdict the reviewer cannot waive.
- **Secrets never enter a prompt.** The packet builder reads an allow-list of
  files; `assertNoSecrets` aborts the run rather than scrubbing, because
  scrubbing would hide the bug that let a secret get that far.
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

Every test runs with **no OpenAI credential, no Anthropic credential, no network
and no live Claude invocation**, using fake adapters. A test suite that costs
money is a test suite that stops being run — and these are exactly the checks
that must survive every change.

## What Autopilot is not

It is not a merge bot, it is not a CI system, and it is not a substitute for
reading the diff. It is a way to let two models do a bounded piece of work
against a boundary that a human wrote, and to stop cleanly when it does not go
well.
