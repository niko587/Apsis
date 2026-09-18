/**
 * The worker prompt: what Claude Code is told, and what it is told not to do.
 *
 * Two of these instructions are load-bearing and neither is enforced by the
 * prompt:
 *
 *   "do not weaken tests to manufacture green" — enforced by the reviewer,
 *   which reads the diff specifically for it.
 *
 *   "do not touch forbidden files" — enforced by the controller, which compares
 *   the actual diff to the spec and rejects regardless of what anyone says.
 *
 * Saying them is still worth doing: a worker that knows the boundary works
 * inside it, and a worker that discovers the boundary by being rejected has
 * already spent a turn. But the prompt is the polite layer. It is not the
 * safety model.
 *
 * Also: the worker does NOT commit. The controller owns git, commits once after
 * gates and review pass, and pushes only on an explicit flag. That keeps
 * "no history rewrite" and "no automatic merge" true by construction rather
 * than by instruction.
 */

import { GATE_NAMES } from './gates.mjs';
import { ALWAYS_FORBIDDEN } from './boundaries.mjs';
import { WORKER_TOOLS, WORKER_DENIED_TOOLS } from './claude.mjs';

const list = (items) => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- (none)');

/**
 * Returns RAW text. The controller runs `assertNoSecrets` on it and only then
 * redacts — redacting here would defeat the abort check (D64).
 */
export function buildWorkerPrompt({ taskSpec, baseSha, branch, worktreePath, projectNotes = '' }) {
  return `# Autopilot task ${taskSpec.taskId}

${taskSpec.title}

You are the implementation engineer in a supervised loop. A planner chose this
task; after you return, a controller will independently run the gates and a
reviewer will read your diff. Your summary is a claim that will be checked.

## Where you are

- repository worktree: ${worktreePath}
- branch: ${branch}
- base commit: ${baseSha}

Work ONLY in this worktree. It is a real checkout on its own branch; nothing you
do here touches the owner's main working tree.

## Goal

${taskSpec.goal}

## Why this task

${taskSpec.reason}

## Files you may create or modify

${list(taskSpec.allowedFiles)}

## Files you must NOT touch

${list(taskSpec.forbiddenFiles)}

Always forbidden, on top of the list above:

${list([...ALWAYS_FORBIDDEN])}

The controller compares the actual diff against these lists after you return. A
change outside the allowed surface fails the task automatically — no reviewer is
consulted and no argument is heard. If you believe the task genuinely cannot be
done inside this surface, say so in your summary and stop; that is a useful
result, and it is better than a rejected diff.

## Invariants that must survive

${list(taskSpec.protectedInvariants)}

## Acceptance criteria

${list(taskSpec.acceptanceCriteria)}

## Gates

The controller will run these itself, in this worktree, after you return:

${list(taskSpec.requiredGates.map((g) => `${g}  (of: ${GATE_NAMES.join(', ')})`))}

**You cannot run them yourself.** Your tools in this session are
${WORKER_TOOLS.join(', ')} — ${WORKER_DENIED_TOOLS.join(' and ')} are disabled, so
there is no shell available to you (D63). That is deliberate for this version of
Autopilot, and it changes how you should work: reason from the code rather than
from a test run, keep changes small enough to be right by inspection, and if a
gate fails you will be told exactly which one and given its real output on a
repair turn. Do not claim you ran anything.

## Rules

- Do not weaken, skip, delete or loosen a test to make a gate pass. If a test is
  genuinely wrong, say why in your summary; the reviewer reads the diff for
  exactly this.
- Do not commit, do not create branches, do not push, do not touch the base
  branch. The controller owns git and will commit once the work is accepted.
- Every file you create is read IN FULL by the reviewer. A new binary file, or
  one too large to inline, cannot be reviewed and will escalate the task — so
  do not add one unless the task asks for it.
- Do not modify any file outside this worktree.
- Do not print, echo, or write any secret, API key or credential anywhere.
- Do not add a dependency unless the task explicitly asks for one.
- Follow the repository's existing conventions and its contracts in docs/.

## Your summary

Return a factual account: what you changed and why, what you could not do, and
anything the reviewer should look at closely.
${projectNotes ? `\n## Repository notes\n\n${projectNotes}\n` : ''}`;
}

/**
 * The repair turn.
 *
 * Built to stand alone. When the installed CLI supports `--resume` this arrives
 * in the original session and is largely redundant; when it does not, this is
 * the whole context, which is why the original task travels with it (B3).
 */
export function buildRepairPrompt({
  taskSpec,
  baseSha,
  branch,
  worktreePath,
  iteration,
  previousSummary,
  gateResults,
  boundary,
  review,
  diff,
  resumed,
}) {
  const failing = gateResults.results
    .filter((r) => !r.ok)
    .map((r) => `### ${r.gate} — FAILED (exit ${r.exitCode})\n\n\`\`\`\n${r.tail}\n\`\`\``)
    .join('\n\n');

  const findings = (review?.findings ?? [])
    .map((f) => `- [${f.severity}] ${f.file}: ${f.issue}\n  required fix: ${f.requiredFix}`)
    .join('\n');

  /**
   * The banner is identical in both cases; only what follows it differs. A
   * fresh worker must learn it is on a repair turn in the first line, not infer
   * it two thousand words later from a "what must be fixed" heading.
   */
  const banner = `# Repair turn ${iteration} for task ${taskSpec.taskId}`;
  const head = resumed
    ? `${banner}\n\nThis continues the session you already have. The task has not changed.`
    : `${banner}\n\nThis session is fresh — the installed Claude CLI could not resume the\nprevious one, so the entire task travels with this prompt. Work already done\nis present in the worktree; read it before changing it.\n\n${buildWorkerPrompt({ taskSpec, baseSha, branch, worktreePath })}`;

  return `${head}

## What must be fixed now (repair turn ${iteration} of ${taskSpec.maxRepairCycles})

${failing || '(all gates passed)'}

${
  boundary && !boundary.ok
    ? `### File boundary — FAILED (${boundary.code})\n\nforbidden files changed: ${boundary.violations.join(', ') || 'none'}\nfiles outside the allowed surface: ${boundary.unlisted.join(', ') || 'none'}\n\nRevert those changes. This is not negotiable and no reviewer can waive it.`
    : ''
}

${review?.summary ? `### Reviewer summary\n\n${review.summary}` : ''}

${findings ? `### Reviewer findings\n\n${findings}` : ''}

${review?.repairPrompt ? `### Reviewer instructions\n\n${review.repairPrompt}` : ''}

## Your previous summary (for reference — it was not verified)

${previousSummary || '(none)'}

## Current diff against ${baseSha}

\`\`\`diff
${diff}
\`\`\`

Fix the causes, not the symptoms. Do not weaken a test to make a gate pass. Do
not commit. Return a factual summary of what changed in this turn.`;
}
