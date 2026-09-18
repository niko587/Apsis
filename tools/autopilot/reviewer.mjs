/**
 * The reviewer: GPT-6 Astra reads a diff that has ALREADY been gated.
 *
 * The ordering is the design. Review happens after the controller has run the
 * tests and checked the file boundary, so the reviewer is answering "is this
 * work correct and in keeping with the repository", not "do you think it
 * compiles". It is told the gate outcomes as facts.
 *
 * And it is told plainly what it cannot do. A reviewer verdict of `accept`
 * over a failed gate, a forbidden-file change, a moved base or an exhausted
 * repair budget does not accept anything — the controller already decided. This
 * is stated in the instructions because a reviewer that knows which levers are
 * real spends its attention on the ones that are.
 */

import { REVIEW_RESULT_SCHEMA_FOR_MODEL, parseReviewResult } from './schemas.mjs';
import { requestStructured } from './openai.mjs';
import { redact } from './redaction.mjs';

export const REVIEWER_INSTRUCTIONS = `You are the reviewing half of a supervised
automation loop for the Apsis repository. A Claude Code worker implemented the
task below in an isolated git worktree. The local controller has already run the
required gates itself and already checked the diff against the task's file
boundary; both outcomes are given to you as facts, not claims.

Judge the work against the task's acceptanceCriteria and protectedInvariants,
and against the repository's contracts and stated decisions.

Look hardest at the things gates cannot see:
- a test that was weakened, deleted, skipped, or rewritten to assert less;
- an assertion that now passes for the wrong reason;
- a change that satisfies the letter of the goal and breaks a stated invariant;
- a "fix" that hides a defect instead of removing it;
- new behaviour with no test, or a test with no behaviour;
- documentation updated to match a claim the code does not support.

Verdicts:
- "accept" — the work meets the acceptance criteria and breaks nothing stated.
- "repair" — a bounded, describable set of fixes would make it acceptable. You
  MUST fill repairPrompt with instructions precise enough for the worker to act
  on without guessing.
- "escalate" — the task was wrong, the approach is unsound, or the situation
  needs the owner. Fill ownerAttention.

What your verdict CANNOT do, because the controller decided it first:
- it cannot pass a failed gate;
- it cannot permit a change to a forbidden or unlisted file;
- it cannot merge anything, and nothing merges automatically in this version;
- it cannot extend the repair budget.

Set repairPrompt to "" unless the verdict is "repair". Set ownerAttention to ""
unless the owner genuinely needs to look.`;

export function buildReviewPacket({
  taskSpec,
  baseSha,
  branch,
  changedFiles,
  diff,
  gateResults,
  boundary,
  workerSummary,
  iteration,
}) {
  const gates = gateResults.results
    .map((r) => `- ${r.gate}: ${r.ok ? 'PASS' : 'FAIL'} (exit ${r.exitCode}, ${Math.round(r.durationMs / 1000)}s)`)
    .join('\n');

  const failures = gateResults.results
    .filter((r) => !r.ok)
    .map((r) => `### ${r.gate} output (tail)\n\n\`\`\`\n${r.tail}\n\`\`\``)
    .join('\n\n');

  return redact(
    [
      `## TaskSpec\n\n\`\`\`json\n${JSON.stringify(taskSpec, null, 2)}\n\`\`\``,
      `## Position\n\n- base commit: ${baseSha}\n- branch: ${branch}\n- repair iteration: ${iteration}`,
      `## Changed files (${changedFiles.length})\n\n${changedFiles.map((f) => `- ${f}`).join('\n') || '- (none)'}`,
      `## File-boundary check (controller)\n\n${
        boundary.ok
          ? 'PASS — every changed file is inside the declared surface.'
          : `FAIL — ${boundary.code}. forbidden: ${boundary.violations.join(', ') || 'none'}; unlisted: ${boundary.unlisted.join(', ') || 'none'}`
      }`,
      `## Gate results (controller ran these, in the worktree)\n\n${gates || '- (none run)'}`,
      failures,
      `## Worker summary (the worker's own account — treat as a claim)\n\n${workerSummary}`,
      `## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

export async function reviewWork({
  packet,
  apiKey,
  model,
  reasoningEffort,
  fetchImpl,
  requestImpl = requestStructured,
}) {
  const { data, raw } = await requestImpl({
    apiKey,
    model,
    reasoningEffort,
    instructions: REVIEWER_INSTRUCTIONS,
    input: packet,
    schemaName: 'ReviewResult',
    schema: REVIEW_RESULT_SCHEMA_FOR_MODEL,
    fetchImpl,
  });
  return { review: parseReviewResult(data), raw };
}
