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

## What Autopilot never does

- merge anything (v1 ends at owner approval)
- push to `main`, or push at all without `--push-branch`
- force-push, reset, rebase, or rewrite any history
- delete anything outside `.apsis-autopilot/`
- execute a command that a model produced
- send a secret to any model
- add a dependency to the root project
- deploy

## Scope of automation, stated plainly

Autonomy happens **inside a task worktree**. The worktree is a real checkout on
its own branch, created from an exact base commit, and the owner's working tree
is never touched. The final merge is an owner decision — deliberately, and not
because merging is technically difficult.
