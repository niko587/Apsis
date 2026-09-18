/**
 * The controller. Everything above this file proposes; this file decides.
 *
 * The ordering below is the safety model, and it is worth reading as an
 * ordering rather than as steps:
 *
 *   preflight  — refuse to start on a dirty tree, so "what changed" is answerable
 *   plan       — one TaskSpec, validated twice, paths checked before use
 *   isolate    — a branch and a worktree; main is never the working surface
 *   implement  — the worker writes; it does not commit and does not push
 *   boundary   — the controller compares the real diff to the declared surface
 *   gates      — the controller runs the tests; the worker's claim is not evidence
 *   review     — GPT reads a diff that is already gated and already bounded
 *   decide     — controller facts beat reviewer opinion, always
 *   stop       — at owner approval; there is no merge in this version
 *
 * Four decisions the reviewer cannot touch, enforced here and nowhere else:
 * a failed gate, a boundary violation, a base branch that moved under us, and
 * an exhausted repair budget. Each of those is a fact about the repository, and
 * facts are not a thing a model gets a vote on.
 */

import { randomUUID } from 'node:crypto';
import { AutopilotError, CODES, fail } from './errors.mjs';
import { enforceBoundaries, branchNameFor, worktreeDirFor, ALWAYS_FORBIDDEN } from './boundaries.mjs';
import { runGates } from './gates.mjs';
import { buildProjectPacket } from './context.mjs';
import { planTask } from './planner.mjs';
import { buildReviewPacket, reviewWork } from './reviewer.mjs';
import { buildWorkerPrompt, buildRepairPrompt } from './worker-prompt.mjs';
import { runWorker, supportsResume, claudeAvailable } from './claude.mjs';
import { createRunStore } from './run-state.mjs';
import { assertNoSecrets, redact } from './redaction.mjs';
import { defaultGit } from './git.mjs';

export const OUTCOMES = Object.freeze({
  READY: 'ready-for-owner-approval',
  ESCALATED: 'escalated',
  PLANNED: 'planned',
  DRY_RUN: 'dry-run',
  FAILED: 'failed',
});

/**
 * Default dependency set. Every external effect is injected, which is what lets
 * the whole loop be tested with no credential, no network and no worker.
 */
export const realDeps = Object.freeze({
  git: defaultGit,
  planTask,
  reviewWork,
  runWorker,
  runGates,
  supportsResume,
  claudeAvailable,
  createRunStore,
  buildProjectPacket,
  log: (line) => process.stdout.write(`${line}\n`),
});

export async function runAutopilot(options, injected = {}) {
  const deps = { ...realDeps, ...injected };
  const {
    mode = 'run',
    ownerGoal,
    config,
    taskIndex = 1,
    pushBranch = false,
    cwd = process.cwd(),
  } = options;

  const git = deps.git;
  const root = await git.repoRoot(cwd);

  /* 1 — PREFLIGHT ------------------------------------------------------- */

  // A dirty tree makes "what did the worker change" unanswerable, and makes an
  // abandoned run's cleanup ambiguous. Refusing is cheaper than guessing.
  if (!(await git.isClean(root))) {
    fail(
      CODES.DIRTY_TREE,
      'the working tree has uncommitted changes — commit or stash them before running Autopilot',
      { status: (await git.statusPorcelain(root)).slice(0, 2000) },
    );
  }

  /**
   * A real run spends money in a process nobody is watching, so the ceiling is
   * the owner's to set and there is no default (D66).
   *
   * Inventing a number would be pretending to know how much a task of unknown
   * size costs on the owner's plan. Requiring one costs a single environment
   * variable and makes the ceiling a decision rather than a discovery. `plan`
   * and `dry-run` never invoke a worker, so they never ask.
   */
  if (mode === 'run' && (config.workerBudgetUsd === null || config.workerBudgetUsd === undefined)) {
    fail(
      CODES.NO_BUDGET,
      'set APSIS_AUTOPILOT_WORKER_BUDGET_USD before a real run — it becomes `claude --max-budget-usd` and is the only hard ceiling on worker spend. Pick a number you would be relaxed about losing; see tools/autopilot/README.md.',
    );
  }

  const baseBranch = await git.currentBranch(root);
  const baseSha = await git.headSha(root);
  const recentLog = await git.recentLog(20, root);

  const store = deps.createRunStore({ root });
  store.update({
    mode,
    ownerGoal,
    baseBranch,
    baseSha,
    config: {
      openaiModel: config.openaiModel,
      reasoningEffort: config.reasoningEffort,
      claudeModel: config.claudeModel,
      maxRepairCycles: config.maxRepairCycles,
    },
  });
  store.step('preflight', { baseBranch, baseSha });

  try {
    /* 2 — PLAN --------------------------------------------------------- */

    const packet = await deps.buildProjectPacket({ root, ownerGoal, headSha: baseSha, baseBranch, recentLog });
    assertNoSecrets(packet);
    store.step('packet-built', { bytes: packet.length });

    // Exactly one planning call per task (B13). The count is structural: there
    // is no loop around this.
    const { taskSpec } = await deps.planTask({
      packet,
      apiKey: config.readApiKey(),
      model: config.openaiModel,
      reasoningEffort: config.reasoningEffort,
    });

    store.update({ taskSpec });
    store.writeJson('planner.json', taskSpec);
    store.step('planned', { taskId: taskSpec.taskId, risk: taskSpec.risk, gates: taskSpec.requiredGates });

    if (mode === 'plan') {
      store.update({ status: OUTCOMES.PLANNED });
      return { outcome: OUTCOMES.PLANNED, taskSpec, runId: store.runId, runDir: store.dir };
    }

    const branch = branchNameFor(taskIndex, taskSpec.taskId);
    const worktreeRel = worktreeDirFor(taskIndex, taskSpec.taskId);

    if (mode === 'dry-run') {
      // NOTHING is created. This is the mode whose whole value is that it is
      // inert, so it must not "just" create the branch to be helpful.
      store.update({ status: OUTCOMES.DRY_RUN, branch, worktree: worktreeRel });
      store.step('dry-run', { branch, worktree: worktreeRel });
      return {
        outcome: OUTCOMES.DRY_RUN,
        taskSpec,
        runId: store.runId,
        runDir: store.dir,
        wouldCreate: { branch, worktree: worktreeRel, baseSha },
        wouldRun: taskSpec.requiredGates,
        wouldInvoke: { bin: config.claudeBin, model: taskSpec.workerModel },
      };
    }

    /* 3 — ISOLATE ------------------------------------------------------ */

    const worktreePath = await git.addWorktree({ root, dir: worktreeRel, branch, baseSha });
    store.update({ branch, worktree: worktreeRel });
    store.step('worktree-created', { branch, worktreePath });

    /* 4..8 — IMPLEMENT / BOUNDARY / GATES / REVIEW / DECIDE ------------ */

    const canResume = await deps.supportsResume({ bin: config.claudeBin });
    let sessionId = randomUUID();
    let previousSummary = '';
    let iteration = 0;
    let lastGateResults = null;
    let lastBoundary = null;
    let lastReview = null;
    let changedFiles = [];

    for (;;) {
      const resumed = iteration > 0 && canResume;
      const prompt =
        iteration === 0
          ? buildWorkerPrompt({ taskSpec, baseSha, branch, worktreePath })
          : buildRepairPrompt({
              taskSpec,
              baseSha,
              branch,
              worktreePath,
              iteration,
              previousSummary,
              gateResults: lastGateResults,
              boundary: lastBoundary,
              review: lastReview,
              diff: (await git.reviewDiff(worktreePath, baseSha)).text,
              resumed,
            });

      // Assert on RAW, then redact (D64).
      assertNoSecrets(prompt);
      store.step('worker-turn-start', { iteration, resumed, model: taskSpec.workerModel });

      const worker = await deps.runWorker({
        prompt: redact(prompt),
        cwd: worktreePath,
        bin: config.claudeBin,
        model: taskSpec.workerModel,
        sessionId,
        resumeSessionId: resumed ? sessionId : null,
        maxBudgetUsd: config.workerBudgetUsd,
        timeoutMs: config.workerTimeoutMs,
      });

      sessionId = worker.sessionId ?? sessionId;
      previousSummary = worker.summary;
      store.writeText(`worker-${iteration}.txt`, worker.summary);
      store.step('worker-turn-end', {
        iteration,
        sessionId,
        durationMs: worker.durationMs,
        costUsd: worker.costUsd ?? null,
        // NAMES only — proof the sanitisation ran, with no value anywhere near
        // the record (D62).
        removedEnvCount: worker.removedEnv?.length ?? null,
      });

      /* BOUNDARY #1 — before gates. A run that edited a forbidden file is over,
         and spending forty minutes of e2e to discover that would be theatre. */
      const checkBoundary = async (label) => {
        changedFiles = await git.changedFiles(worktreePath, baseSha);
        const verdict = enforceBoundaries({
          changed: changedFiles,
          allowedFiles: taskSpec.allowedFiles,
          forbiddenFiles: taskSpec.forbiddenFiles,
        });
        store.step('boundary-checked', {
          when: label,
          iteration,
          ok: verdict.ok,
          code: verdict.code,
          changed: changedFiles.length,
          violations: verdict.violations,
          unlisted: verdict.unlisted,
        });
        return verdict;
      };

      lastBoundary = await checkBoundary('after-worker');

      if (lastBoundary.ok) {
        lastGateResults = await deps.runGates(taskSpec.requiredGates, {
          cwd: worktreePath,
          timeoutMs: config.gateTimeoutMs,
        });

        /**
         * BOUNDARY #2 — after gates, and this one is not belt-and-braces.
         *
         * A gate RUNS repository code: `npm run build` writes dist/, a test can
         * write a fixture, a tool can drop a cache. So the surface at the moment
         * of the first check is not the surface that exists at the moment of
         * commit, and `git add -A` would sweep up whatever appeared in between —
         * a file that never received a boundary verdict from anyone.
         *
         * Re-checking here closes the window between the two, and the pre-commit
         * check below closes the window between review and commit.
         */
        lastBoundary = await checkBoundary('after-gates');
      } else {
        // Gates are not run on an out-of-bounds diff; the result must still have
        // the shape the reviewer packet and repair prompt expect.
        lastGateResults = { results: [], ok: false, failed: [], skipped: taskSpec.requiredGates };
      }
      store.writeJson(`gates-${iteration}.json`, lastGateResults);
      store.step('gates-run', { iteration, ok: lastGateResults.ok, failed: lastGateResults.failed });

      /**
       * The diff as the reviewer will see it — new files inlined in full, and
       * anything that could not be read as text named rather than glossed (D65).
       */
      const reviewDiff = await git.reviewDiff(worktreePath, baseSha);
      store.step('diff-built', {
        iteration,
        bytes: reviewDiff.text.length,
        truncated: reviewDiff.truncated,
        unreviewable: reviewDiff.unreviewable.map((u) => `${u.file}:${u.reason}`),
      });

      /**
       * REVIEW — one call per iteration (B13), and only for a diff that is
       * inside the declared surface.
       *
       * An out-of-bounds diff is already decided. Asking a reviewer about it
       * would spend a call to obtain an opinion the controller must ignore, and
       * would put the reviewer in the position of appearing to bless something
       * it cannot.
       */
      let review = null;
      if (lastBoundary.ok) {
        const rawPacket = buildReviewPacket({
          taskSpec,
          baseSha,
          branch,
          changedFiles,
          diff: reviewDiff.text,
          unreviewable: reviewDiff.unreviewable,
          gateResults: lastGateResults,
          boundary: lastBoundary,
          workerSummary: previousSummary,
          iteration,
        });
        // Assert on RAW, then redact (D64) — the same ordering as the packet
        // builder, for the same reason.
        assertNoSecrets(rawPacket);

        ({ review } = await deps.reviewWork({
          packet: redact(rawPacket),
          apiKey: config.readApiKey(),
          model: config.openaiModel,
          reasoningEffort: config.reasoningEffort,
        }));
        lastReview = review;
        store.writeJson(`review-${iteration}.json`, review);
        store.step('reviewed', { iteration, verdict: review.verdict, findings: review.findings.length });
      } else {
        lastReview = null;
        store.step('review-skipped', { iteration, because: lastBoundary.code });
      }

      /* DECIDE — controller facts first, reviewer opinion second. */
      const blocked =
        (!lastBoundary.ok && lastBoundary.code) ||
        (!lastGateResults.ok && CODES.GATE_FAILED) ||
        (reviewDiff.unreviewable.length > 0 && CODES.UNREVIEWABLE) ||
        null;

      if (!blocked && review?.verdict === 'accept') break;

      if (blocked && review?.verdict === 'accept') {
        // Recorded explicitly. A reviewer that accepts a failed run is a signal
        // about the reviewer, and it should be visible in the run record rather
        // than silently discarded.
        store.step('reviewer-overruled', { blocked, verdict: review.verdict });
      }

      /**
       * Files nobody could read do not get a second opinion. Escalating here
       * rather than repairing is deliberate: a binary asset or a 200KB generated
       * file is a decision for the owner, not something a worker should try
       * again differently.
       */
      if (reviewDiff.unreviewable.length > 0) {
        return finishEscalated(store, {
          reason: `${reviewDiff.unreviewable.length} file(s) could not be reviewed as text: ${reviewDiff.unreviewable
            .map((u) => `${u.file} (${u.reason})`)
            .join(', ')}`,
          code: CODES.UNREVIEWABLE,
          review: lastReview,
          branch,
          worktreeRel,
          baseSha,
          taskSpec,
          changedFiles,
          gateResults: lastGateResults,
          boundary: lastBoundary,
        });
      }

      if (review?.verdict === 'escalate') {
        return finishEscalated(store, {
          reason: 'reviewer escalated',
          review,
          branch,
          worktreeRel,
          baseSha,
          taskSpec,
          changedFiles,
          gateResults: lastGateResults,
          boundary: lastBoundary,
        });
      }

      if (iteration >= taskSpec.maxRepairCycles) {
        return finishEscalated(store, {
          reason: `repair limit reached (${taskSpec.maxRepairCycles})`,
          code: CODES.REPAIR_LIMIT,
          review,
          branch,
          worktreeRel,
          baseSha,
          taskSpec,
          changedFiles,
          gateResults: lastGateResults,
          boundary: lastBoundary,
        });
      }

      iteration += 1;
    }

    /* 9 — STALE BASE --------------------------------------------------- */

    // The base branch may have moved while the worker worked. Gates that passed
    // against an old base do not describe the merge the owner is about to
    // consider, so this is an escalation and not a warning.
    const baseNow = await git.revParse(baseBranch, root);
    if (baseNow !== baseSha) {
      return finishEscalated(store, {
        reason: `${baseBranch} moved from ${baseSha.slice(0, 8)} to ${baseNow.slice(0, 8)} during the run — rebase and re-gate before merging`,
        code: CODES.STALE_BASE,
        review: lastReview,
        branch,
        worktreeRel,
        baseSha,
        taskSpec,
        changedFiles,
        gateResults: lastGateResults,
        boundary: lastBoundary,
      });
    }

    /* 10 — BOUNDARY, ONE LAST TIME, IMMEDIATELY BEFORE COMMIT ---------- */

    /**
     * `commitAll` runs `git add -A`. Whatever the working tree holds at that
     * instant is what enters the branch — so the surface that was approved and
     * the surface that gets committed must be shown to be the same surface, at
     * the last possible moment, by the controller.
     *
     * Two separate questions, and both matter:
     *   - is everything still inside the declared boundary? (a new file could
     *     have appeared since the review)
     *   - is it the SAME set the reviewer actually read? (a file that vanished,
     *     or one that appeared, means the review describes something else)
     */
    const finalChanged = await git.changedFiles(worktreePath, baseSha);
    const finalBoundary = enforceBoundaries({
      changed: finalChanged,
      allowedFiles: taskSpec.allowedFiles,
      forbiddenFiles: taskSpec.forbiddenFiles,
    });
    store.step('boundary-checked', {
      when: 'pre-commit',
      ok: finalBoundary.ok,
      code: finalBoundary.code,
      changed: finalChanged.length,
      violations: finalBoundary.violations,
      unlisted: finalBoundary.unlisted,
    });

    if (!finalBoundary.ok) {
      return finishEscalated(store, {
        reason: `the changed surface left the declared boundary between review and commit (${finalBoundary.code}): ${[
          ...finalBoundary.violations,
          ...finalBoundary.unlisted,
          ...finalBoundary.unsafe,
        ].join(', ')}`,
        code: finalBoundary.code,
        review: lastReview,
        branch,
        worktreeRel,
        baseSha,
        taskSpec,
        changedFiles: finalChanged,
        gateResults: lastGateResults,
        boundary: finalBoundary,
      });
    }

    const drift = diffSets(changedFiles, finalChanged);
    if (drift.added.length > 0 || drift.removed.length > 0) {
      return finishEscalated(store, {
        reason: `the changed surface is not the one that was reviewed — appeared: ${drift.added.join(', ') || 'none'}; disappeared: ${drift.removed.join(', ') || 'none'}`,
        code: CODES.SURFACE_DRIFT,
        review: lastReview,
        branch,
        worktreeRel,
        baseSha,
        taskSpec,
        changedFiles: finalChanged,
        gateResults: lastGateResults,
        boundary: finalBoundary,
      });
    }

    /* 11 — COMMIT, AND STOP -------------------------------------------- */

    const headSha = await git.commitAll({
      cwd: worktreePath,
      message: commitMessage(taskSpec, lastReview),
    });
    store.step('committed', { headSha, files: finalChanged.length });

    let pushed = null;
    if (pushBranch) {
      pushed = await git.pushBranch({ cwd: worktreePath, branch });
      store.step('branch-pushed', pushed);
    }

    store.update({
      status: OUTCOMES.READY,
      verdict: lastReview.verdict,
      headSha,
      changedFiles,
      failedGates: [],
    });

    return {
      outcome: OUTCOMES.READY,
      taskSpec,
      runId: store.runId,
      runDir: store.dir,
      branch,
      baseBranch,
      baseSha,
      headSha,
      worktree: worktreeRel,
      changedFiles,
      gateResults: lastGateResults,
      review: lastReview,
      pushed,
      // Printed, never executed. The merge is the owner's action in v1.
      mergeCommand: `git -C ${root} merge --no-ff ${branch}`,
    };
  } catch (error) {
    const code = error instanceof AutopilotError ? error.code : 'unexpected';
    store.update({ status: OUTCOMES.FAILED, stoppedBecause: `${code}: ${redact(error.message)}` });
    store.step('failed', { code, message: redact(error.message) });
    throw error;
  }
}

function finishEscalated(store, detail) {
  store.update({
    status: OUTCOMES.ESCALATED,
    verdict: detail.review?.verdict ?? null,
    stoppedBecause: detail.reason,
    failedGates: detail.gateResults?.failed ?? [],
    changedFiles: detail.changedFiles ?? [],
  });
  store.step('escalated', { reason: detail.reason, code: detail.code ?? null });
  return {
    outcome: OUTCOMES.ESCALATED,
    runId: store.runId,
    runDir: store.dir,
    reason: detail.reason,
    code: detail.code ?? null,
    taskSpec: detail.taskSpec,
    branch: detail.branch,
    worktree: detail.worktreeRel,
    baseSha: detail.baseSha,
    changedFiles: detail.changedFiles ?? [],
    gateResults: detail.gateResults,
    boundary: detail.boundary,
    review: detail.review,
  };
}

/** Set difference both ways, for the surface-drift check. */
const diffSets = (before, after) => {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: after.filter((f) => !a.has(f)),
    removed: before.filter((f) => !b.has(f)),
  };
};

const commitMessage = (taskSpec, review) =>
  [
    `${taskSpec.title}`,
    '',
    taskSpec.goal.trim(),
    '',
    `Autopilot task ${taskSpec.taskId}. Gates run by the controller; reviewed by`,
    `the planner model and accepted. Not merged — awaiting owner approval.`,
    review?.summary ? `\nReviewer: ${review.summary.trim().slice(0, 500)}` : '',
  ]
    .join('\n')
    .trim();

export const __test = { commitMessage, diffSets, ALWAYS_FORBIDDEN };
