/**
 * The planner: GPT-6 Astra chooses ONE bounded task.
 *
 * "One" is a controller constraint, not a request. The schema has no array of
 * tasks, so a planner that wanted to queue five could not express it. That is
 * the difference between a limit and a preference.
 *
 * What the planner is told about the gates is the enum of names. It is told
 * explicitly that it cannot supply commands, because a model that understands
 * the boundary writes better specs than one that keeps trying to cross it.
 */

import { GATE_NAMES } from './gates.mjs';
import { TASK_SPEC_SCHEMA_FOR_MODEL, parseTaskSpec, WORKER_MODELS, MAX_REPAIR_CYCLES } from './schemas.mjs';
import { assertSafeRepoPaths } from './boundaries.mjs';
import { requestStructured } from './openai.mjs';

export const PLANNER_INSTRUCTIONS = `You are the planning half of a supervised
automation loop for the Apsis repository. A local controller executes your plan;
a Claude Code worker implements it; the controller runs the tests. You never run
anything yourself.

Produce EXACTLY ONE bounded task that moves the owner goal forward.

What makes a good task here:
- It is small enough that one worker turn can finish it and a reviewer can check it.
- It follows the repository's existing architecture, contracts, CURRENT_STATE and
  NEXT_ACTIONS. Those documents are authoritative; your own sense of what a sales
  product "should" have is not.
- It names, in allowedFiles, every path the worker may create or modify — as
  repo-relative globs. Be generous enough that honest work is not blocked and
  tight enough that the surface is reviewable. Include the test files the work
  needs.
- It names, in forbiddenFiles, the paths this particular task must not touch.
  (The controller adds its own always-forbidden list on top: .env files, the
  autopilot tool itself, .git.)
- It states protectedInvariants: properties of the repository that must survive.
  Take these from the contracts and DECISIONS, not from imagination.
- acceptanceCriteria must be checkable by reading a diff and a test result.

Hard limits you must respect:
- requiredGates may contain ONLY these names: ${GATE_NAMES.join(', ')}. They are
  names of gates the controller owns. You cannot supply shell commands, and
  there is no field in which to try.
- workerModel must be one of: ${WORKER_MODELS.join(', ')}. Use claude-fable-5
  only for work that is primarily visual/front-end craft; otherwise
  claude-opus-5.
- maxRepairCycles is at most ${MAX_REPAIR_CYCLES}.
- allowedFiles and forbiddenFiles are repo-relative. A path containing ".." or a
  leading "/" will be rejected by the controller and the run will abort.

The owner goal outranks everything else in the packet. Do not propose work
outside the scope stated in the policy section of the packet. If the repository
looks finished with respect to the owner goal, choose the smallest genuinely
useful consolidation task (a missing test, a stale document, a measured
hygiene item) rather than inventing a new feature.`;

/**
 * @returns {Promise<{taskSpec: object, raw: object}>}
 */
export async function planTask({
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
    instructions: PLANNER_INSTRUCTIONS,
    input: packet,
    schemaName: 'TaskSpec',
    schema: TASK_SPEC_SCHEMA_FOR_MODEL,
    fetchImpl,
  });

  // Validated a second time on this side, then path-checked. Order matters: a
  // path that escapes the repository must be rejected before anything derives a
  // branch name or a directory from the spec.
  const taskSpec = parseTaskSpec(data);
  assertSafeRepoPaths(taskSpec.allowedFiles, 'TaskSpec.allowedFiles');
  assertSafeRepoPaths(taskSpec.forbiddenFiles, 'TaskSpec.forbiddenFiles');

  return { taskSpec, raw };
}
