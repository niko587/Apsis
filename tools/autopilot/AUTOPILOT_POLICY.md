# Autopilot policy

This file is included in every planner packet. It is what the planning model is
held to, and it is what the owner can hold a plan against.

## Default objective

**Finish and optimize the Apsis prototype / product experience**, according to
this repository's existing architecture, contracts, `docs/CURRENT_STATE.md` and
`docs/NEXT_ACTIONS.md`.

Those documents are authoritative. A model's general sense of what a sales
product "should" have is not.

Prefer, in roughly this order:

1. Closing a gap the repository already states it has.
2. A test that would have caught a real defect.
3. Documentation that is currently making a claim the code does not support.
4. Measured performance or hygiene work — measured, not assumed.
5. Polish the owner would actually notice.

If the repository looks finished with respect to the goal, choose the smallest
genuinely useful consolidation task rather than inventing a feature. "Nothing
worth doing" is a legitimate thing for a plan to conclude; a feature invented to
fill the silence is not.

## The owner goal outranks the roadmap

`--goal` (or `.autopilot-goal`, or `--goal-file`) replaces the default objective
above. When the owner states a goal, model-generated roadmap ideas lose to it,
including ideas this file endorses.

## Out of scope unless the owner explicitly changes the goal

- production CRM integration
- real customer data ingestion
- a cloud database or any durable customer datastore
- billing, payments or subscription handling
- outbound calling, SMS or email vendors
- destructive migrations, or any migration of real data
- deployment to production, or changes to deployment credentials
- sending messages or posting anywhere outside this repository

These are not off the list because they are hard. They are off the list because
each one has a consequence outside this repository — a real person's data, a
real bill, a real message to a real customer — and an unattended loop should not
be the thing that causes an irreversible action in the world.

## What the controller enforces regardless of what any model says

The planner and reviewer are advisory in these four areas. The controller
decides, and no verdict overrides it:

| Fact | Consequence |
|---|---|
| A required gate failed | The task cannot be accepted. |
| A forbidden or unlisted file changed | Automatic rejection; gates are not even run. |
| The base branch moved during the run | Escalate — the gate results describe a merge that no longer exists. |
| The repair budget is exhausted | Stop. Do not keep spending. |
| A file could not be read as text (binary, or too large) | Escalate — nobody reviewed it, so nobody may bless it. |
| The committed surface differs from the reviewed surface | Escalate — the review describes something else. |

## The trust boundary, stated honestly

**This is not an OS sandbox, and v1 must not be described as one.**

What IS structurally constrained:

- **git and `main`.** The worker never commits, pushes, or touches the base
  branch; the controller's git surface has no force push, no reset, no rebase,
  no branch delete and no merge. Work happens in a dedicated worktree.
- **The file surface.** The controller compares the real diff to the declared
  boundary three times — after the worker, after the gates, and immediately
  before the commit — so a file that appears at any point in between still gets
  a verdict.
- **Secrets.** Neither the Claude worker nor any gate subprocess inherits the
  owner's credentials. `OPENAI_API_KEY` in particular is the controller's alone
  and never reaches the other provider's process.
- **The worker's tools.** Read, Edit, Write, Glob and Grep. **No Bash in v1**,
  no MCP servers, and the owner's personal Claude settings are not loaded.

What is NOT constrained, and cannot be by this design:

- **The gates execute repository code.** `npm test` and `npm run build` run a
  test file and a build config that a model may have just written. That code
  runs as the owner's user, on the owner's machine, with filesystem and network
  access. Stripping credentials from its environment reduces what it can steal;
  it does not stop it from running.
- **The worker can write any file inside its worktree.** The boundary check
  catches it afterwards and refuses the task — which is detection, not
  prevention. An out-of-bounds file is never committed, but it was written.

So: **v1 is for supervised use on this repository, which the owner trusts.**
Watch the first runs. Read the diffs. It is a loop that does bounded work behind
boundaries a human wrote — not a container, and not a system for running code
you have reason to distrust.

**Level-3 unattended autonomy — leaving it running without watching — requires a
stronger execution sandbox or an isolated runner first.** That is a separate
piece of work and is deliberately not attempted here.

## What Autopilot never does

- merge anything (v1 ends at owner approval)
- push to `main`, or push at all without `--push-branch`
- force-push, reset, rebase, or rewrite any history
- delete anything outside `.apsis-autopilot/`
- execute a command that a model produced
- send a secret to any model
- add a dependency to the root project
- hand the Claude worker the owner's OpenAI key, or any other credential
- give the worker a shell
- start a real run without an explicit spend ceiling
- deploy

## Scope of automation, stated plainly

Autonomy happens **inside a task worktree**. The worktree is a real checkout on
its own branch, created from an exact base commit, and the owner's working tree
is never touched. The final merge is an owner decision — deliberately, and not
because merging is technically difficult.
