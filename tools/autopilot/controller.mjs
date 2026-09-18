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
              diff: await git.diffText(worktreePath, baseSha),
              resumed,
            });

      assertNoSecrets(prompt);
      store.step('worker-turn-start', { iteration, resumed, model: taskSpec.workerModel });

      const worker = await deps.runWorker({
        prompt,
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
      });

      /* boundary BEFORE gates: a run that edited a forbidden file is over, and
         spending forty minutes of e2e to discover that would be theatre. */
      changedFiles = await git.changedFiles(worktreePath, baseSha);
      lastBoundary = enforceBoundaries({
        changed: changedFiles,
        allowedFiles: taskSpec.allowedFiles,
        forbiddenFiles: taskSpec.forbiddenFiles,
      });
      store.step('boundary-checked', {
        ok: lastBoundary.ok,
        code: lastBoundary.code,
        changed: changedFiles.length,
        violations: lastBoundary.violations,
        unlisted: lastBoundary.unlisted,
      });

      if (lastBoundary.ok) {
        lastGateResults = await deps.runGates(taskSpec.requiredGates, {
          cwd: worktreePath,
          timeoutMs: config.gateTimeoutMs,
        });
      } else {
        // Gates are not run on an out-of-bounds diff; the result must still have
        // the shape the reviewer packet and repair prompt expect.
        lastGateResults = { results: [], ok: false, failed: [], skipped: taskSpec.requiredGates };
      }
      store.writeJson(`gates-${iteration}.json`, lastGateResults);
      store.step('gates-run', { iteration, ok: lastGateResults.ok, failed: lastGateResults.failed });

      /* REVIEW — one call per iteration (B13). */
      const reviewPacket = buildReviewPacket({
        taskSpec,
        baseSha,
        branch,
        changedFiles,
        diff: await git.diffText(worktreePath, baseSha),
        gateResults: lastGateResults,
        boundary: lastBoundary,
        workerSummary: previousSummary,
        iteration,
      });
      assertNoSecrets(reviewPacket);

      const { review } = await deps.reviewWork({
        packet: reviewPacket,
        apiKey: config.readApiKey(),
        model: config.openaiModel,
        reasoningEffort: config.reasoningEffort,
      });
      lastReview = review;
      store.writeJson(`review-${iteration}.json`, review);
      store.step('reviewed', { iteration, verdict: review.verdict, findings: review.findings.length });

      /* DECIDE — controller facts first, reviewer opinion second. */
      const blocked =
        (!lastBoundary.ok && lastBoundary.code) ||
        (!lastGateResults.ok && CODES.GATE_FAILED) ||
        null;

      if (!blocked && review.verdict === 'accept') break;

      if (blocked && review.verdict === 'accept') {
        // Recorded explicitly. A reviewer that accepts a failed run is a signal
        // about the reviewer, and it should be visible in the run record rather
        // than silently discarded.
        store.step('reviewer-overruled', { blocked, verdict: review.verdict });
      }

      if (review.verdict === 'escalate') {
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

    /* 10 — COMMIT, AND STOP -------------------------------------------- */

    const headSha = await git.commitAll({
      cwd: worktreePath,
      message: commitMessage(taskSpec, lastReview),
    });
    store.step('committed', { headSha });

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

export const __test = { commitMessage, ALWAYS_FORBIDDEN };
