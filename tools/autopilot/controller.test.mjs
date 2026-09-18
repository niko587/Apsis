/**
 * Tests 5, 6, 7, 11, 12, 13, 17 and 18: the loop itself, driven entirely by
 * fake adapters.
 *
 * No OpenAI credential, no Anthropic credential, no live Claude invocation, no
 * network, no real git repository. That is a requirement, not a convenience
 * (B21): a test suite that costs money is a test suite that stops being run,
 * and the properties asserted here — a failed gate cannot be talked past, a
 * repair loop terminates, a run ends at approval rather than at merge — are
 * exactly the ones that must be checked on every change.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { runAutopilot, OUTCOMES } from './controller.mjs';
import { CODES } from './errors.mjs';
import { validSpec, validReview } from './schemas.test.mjs';

/* ------------------------------------------------------------------ fakes */

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apsis-autopilot-test-'));

function fakeGit(over = {}) {
  const state = {
    clean: true,
    baseSha: 'a'.repeat(40),
    baseBranch: 'main',
    changed: ['src/universe/UniverseOverlay.tsx'],
    worktrees: [],
    commits: [],
    pushes: [],
    baseNow: null,
    ...over,
  };
  return {
    state,
    repoRoot: async () => state.root,
    isClean: async () => state.clean,
    statusPorcelain: async () => (state.clean ? '' : ' M src/App.tsx'),
    currentBranch: async () => state.baseBranch,
    headSha: async () => state.baseSha,
    revParse: async (ref) => (ref === state.baseBranch ? (state.baseNow ?? state.baseSha) : state.baseSha),
    recentLog: async () => 'abc1234 a commit',
    version: async () => 'git version 2.50.0',
    changedFiles: async () => state.changed,
    diffText: async () => 'diff --git a/x b/x\n+one line\n',
    addWorktree: async ({ root, dir, branch, baseSha }) => {
      state.worktrees.push({ dir, branch, baseSha });
      const full = path.join(root, dir);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },
    removeWorktree: async () => {},
    commitAll: async ({ message }) => {
      state.commits.push(message);
      return 'b'.repeat(40);
    },
    pushBranch: async ({ branch, remote = 'origin' }) => {
      state.pushes.push(branch);
      return { remote, branch };
    },
  };
}

/** A worker that never runs anything — it just reports what it was told to. */
function fakeWorker({ summaries = ['did the thing'], onCall } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    onCall?.(args, calls.length - 1);
    return {
      summary: summaries[Math.min(calls.length - 1, summaries.length - 1)],
      sessionId: args.resumeSessionId ?? args.sessionId ?? 'session-1',
      exitCode: 0,
      durationMs: 10,
      costUsd: 0.01,
      stderr: '',
    };
  };
  run.calls = calls;
  return run;
}

function fakeGates(sequence) {
  const calls = [];
  const run = async (names) => {
    const outcome = sequence[Math.min(calls.length, sequence.length - 1)];
    calls.push(names);
    const results = names.map((gate) => ({
      gate,
      ok: outcome,
      exitCode: outcome ? 0 : 1,
      durationMs: 5,
      tail: outcome ? '' : `${gate} failed: 1 test failing`,
    }));
    return {
      results: outcome ? results : results.slice(0, 1),
      ok: outcome,
      failed: outcome ? [] : [names[0]],
      skipped: outcome ? [] : names.slice(1),
    };
  };
  run.calls = calls;
  return run;
}

function fakeReviewer(verdicts) {
  const calls = [];
  const run = async () => {
    const verdict = verdicts[Math.min(calls.length, verdicts.length - 1)];
    calls.push(verdict);
    return {
      review: validReview(
        verdict === 'repair'
          ? { verdict, repairPrompt: 'fix the failing assertion, do not delete it' }
          : { verdict },
      ),
    };
  };
  run.calls = calls;
  return run;
}

function harness(over = {}) {
  const root = tmpRoot();
  const git = fakeGit({ root, ...(over.gitState ?? {}) });
  const worker = over.runWorker ?? fakeWorker();
  const gates = over.runGates ?? fakeGates([true]);
  const reviewer = over.reviewWork ?? fakeReviewer(['accept']);
  const planner =
    over.planTask ?? (async () => ({ taskSpec: { ...validSpec(), ...(over.specOver ?? {}) } }));

  const deps = {
    git,
    planTask: planner,
    reviewWork: reviewer,
    runWorker: worker,
    runGates: gates,
    supportsResume: over.supportsResume ?? (async () => true),
    buildProjectPacket: async () => 'PACKET',
    log: () => {},
  };

  const config = {
    openaiModel: 'gpt-6-astra',
    reasoningEffort: 'high',
    claudeModel: 'claude-opus-5',
    claudeBin: 'claude',
    maxRepairCycles: 3,
    workerBudgetUsd: null,
    gateTimeoutMs: 1000,
    workerTimeoutMs: 1000,
    hasApiKey: true,
    readApiKey: () => 'sk-fake-000000000000000000',
  };

  return { root, git, worker, gates, reviewer, deps, config };
}

const run = (h, options = {}) =>
  runAutopilot({ mode: 'run', ownerGoal: 'finish the prototype', config: h.config, cwd: h.root, ...options }, h.deps);

/* ------------------------------------------------------------------ tests */

test('12. a successful fake end-to-end run ends at OWNER APPROVAL, not at a merge', async () => {
  const h = harness();
  const result = await run(h);

  assert.equal(result.outcome, OUTCOMES.READY);
  assert.equal(result.review.verdict, 'accept');
  assert.equal(h.git.state.commits.length, 1, 'the controller commits on the task branch');
  assert.equal(h.git.state.pushes.length, 0, 'nothing is pushed without --push-branch');
  assert.match(result.branch, /^autopilot\/task-0001-/);

  // The merge is PRINTED, never executed. No git call in the fake merged anything.
  assert.match(result.mergeCommand, /git -C .* merge --no-ff autopilot\//);
  assert.ok(!('merged' in result));
});

test('12. --push-branch pushes the task branch only, and only when asked', async () => {
  const h = harness();
  const result = await run(h, { pushBranch: true });
  assert.deepEqual(h.git.state.pushes, [result.branch]);
  assert.match(h.git.state.pushes[0], /^autopilot\//);
});

test('5. a failed gate rejects the task even when the reviewer says accept', async () => {
  // The reviewer is enthusiastic and wrong. It does not matter.
  const h = harness({ runGates: fakeGates([false]), reviewWork: fakeReviewer(['accept']) });
  const result = await run(h);

  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.REPAIR_LIMIT);
  assert.deepEqual(result.gateResults.failed, ['typecheck']);
  assert.equal(h.git.state.commits.length, 0, 'nothing may be committed over a failed gate');

  const record = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'));
  assert.ok(
    record.steps.some((s) => s.name === 'reviewer-overruled'),
    'an accept over a failed gate must be recorded, not silently dropped',
  );
});

test('4/5. a forbidden-file change rejects the task and gates are not even run', async () => {
  const h = harness({ gitState: { changed: ['src/ui/LeadList.tsx'] }, reviewWork: fakeReviewer(['accept']) });
  const result = await run(h);

  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.boundary.code, CODES.FORBIDDEN_FILE);
  assert.equal(h.gates.calls.length, 0, 'no point spending forty minutes of e2e on an out-of-bounds diff');
  assert.equal(h.git.state.commits.length, 0);
});

test('6. the repair cycle limit stops the run', async () => {
  const h = harness({
    runGates: fakeGates([false]),
    reviewWork: fakeReviewer(['repair']),
    specOver: { maxRepairCycles: 2 },
  });
  const result = await run(h);

  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.REPAIR_LIMIT);
  // Turn 0 plus two repairs, then stop. Not four, not forever.
  assert.equal(h.worker.calls.length, 3);
  assert.equal(h.gates.calls.length, 3);
  assert.equal(h.reviewer.calls.length, 3, 'exactly one review per iteration (B13)');
  assert.equal(h.git.state.commits.length, 0);
});

test('11. the repair loop converges: a failing first turn that is fixed ends READY', async () => {
  const h = harness({
    runGates: fakeGates([false, true]),
    reviewWork: fakeReviewer(['repair', 'accept']),
  });
  const result = await run(h);

  assert.equal(result.outcome, OUTCOMES.READY);
  assert.equal(h.worker.calls.length, 2);
  assert.equal(h.git.state.commits.length, 1);
});

test('11. a repair turn resumes the same worker session when the CLI supports it', async () => {
  const h = harness({ runGates: fakeGates([false, true]), reviewWork: fakeReviewer(['repair', 'accept']) });
  await run(h);

  const [first, second] = h.worker.calls;
  assert.equal(first.resumeSessionId, null);
  assert.equal(second.resumeSessionId, first.sessionId, 'the repair continues the session');
  assert.match(second.prompt, /Repair turn 1/);
  assert.match(second.prompt, /do not weaken a test/i);
});

test('11. without --resume support the repair turn carries the FULL task, not a fragment', async () => {
  const h = harness({
    runGates: fakeGates([false, true]),
    reviewWork: fakeReviewer(['repair', 'accept']),
    supportsResume: async () => false,
  });
  const result = await run(h);

  assert.equal(result.outcome, OUTCOMES.READY, 'resume availability is not a correctness dependency');
  const [, second] = h.worker.calls;
  assert.equal(second.resumeSessionId, null);
  // The original goal, the boundary and the acceptance criteria all travel again.
  assert.match(second.prompt, /Files you may create or modify/);
  assert.match(second.prompt, /polish-empty-state/);
  assert.match(second.prompt, /Repair turn 1/);
});

test('11. the repair prompt carries the actual failing gate output and the findings', async () => {
  const h = harness({ runGates: fakeGates([false, true]), reviewWork: fakeReviewer(['repair', 'accept']) });
  await run(h);
  const [, second] = h.worker.calls;
  assert.match(second.prompt, /typecheck — FAILED/);
  assert.match(second.prompt, /1 test failing/);
  assert.match(second.prompt, /fix the failing assertion, do not delete it/);
});

test('7. a dirty working tree prevents the run entirely', async () => {
  const h = harness({ gitState: { clean: false } });
  await assert.rejects(run(h), (e) => {
    assert.equal(e.code, CODES.DIRTY_TREE);
    return true;
  });
  assert.equal(h.worker.calls.length, 0);
  assert.equal(h.git.state.worktrees.length, 0, 'not even a worktree is created');
});

test('13. dry-run creates no branch, no worktree, and invokes no worker', async () => {
  const h = harness();
  const result = await run(h, { mode: 'dry-run' });

  assert.equal(result.outcome, OUTCOMES.DRY_RUN);
  assert.equal(h.git.state.worktrees.length, 0);
  assert.equal(h.git.state.commits.length, 0);
  assert.equal(h.worker.calls.length, 0);
  assert.equal(h.gates.calls.length, 0);
  assert.equal(h.reviewer.calls.length, 0);
  // It still says exactly what it WOULD do.
  assert.match(result.wouldCreate.branch, /^autopilot\/task-0001-/);
  assert.deepEqual(result.wouldRun, ['typecheck', 'unit', 'build']);
});

test('plan mode stops after the TaskSpec, with no git mutation and no worker', async () => {
  const h = harness();
  const result = await run(h, { mode: 'plan' });
  assert.equal(result.outcome, OUTCOMES.PLANNED);
  assert.equal(h.git.state.worktrees.length, 0);
  assert.equal(h.worker.calls.length, 0);
  assert.ok(fs.existsSync(path.join(result.runDir, 'planner.json')));
});

test('18. a base branch that moved during the run is caught BEFORE approval', async () => {
  // Gates passed against a base that no longer exists as HEAD of main. The
  // result does not describe the merge the owner is about to consider.
  const h = harness();
  const original = h.git.revParse;
  h.git.revParse = async (ref) => (ref === 'main' ? 'c'.repeat(40) : original(ref));

  const result = await run(h);
  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.STALE_BASE);
  assert.match(result.reason, /moved from/);
  assert.equal(h.git.state.commits.length, 0, 'nothing is committed on a stale base');
});

test('17. a worker failure fails the run closed', async () => {
  const h = harness({
    runWorker: async () => {
      const error = new Error('worker exited 1');
      error.code = CODES.WORKER_FAILED;
      throw error;
    },
  });
  await assert.rejects(run(h), (e) => e.code === CODES.WORKER_FAILED);
  assert.equal(h.gates.calls.length, 0);
  assert.equal(h.git.state.commits.length, 0);
});

test('17. a planner failure fails the run closed, before any git mutation', async () => {
  const h = harness({
    planTask: async () => {
      const error = new Error('bad json');
      error.code = CODES.OPENAI_MALFORMED;
      throw error;
    },
  });
  await assert.rejects(run(h), (e) => e.code === CODES.OPENAI_MALFORMED);
  assert.equal(h.git.state.worktrees.length, 0);
});

test('a reviewer escalation stops immediately without spending the repair budget', async () => {
  const h = harness({ reviewWork: fakeReviewer(['escalate']) });
  const result = await run(h);
  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(h.worker.calls.length, 1);
  assert.equal(h.git.state.commits.length, 0);
});

test('the run record is written at every step and is diagnosable afterwards', async () => {
  const h = harness();
  const result = await run(h);
  const record = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'));

  assert.equal(record.status, OUTCOMES.READY);
  const names = record.steps.map((s) => s.name);
  for (const expected of ['preflight', 'planned', 'worktree-created', 'worker-turn-end', 'gates-run', 'reviewed', 'committed']) {
    assert.ok(names.includes(expected), `missing step ${expected}`);
  }
  assert.ok(fs.existsSync(path.join(result.runDir, 'worker-0.txt')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'gates-0.json')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'review-0.json')));
});

test('the run record never contains the API key', async () => {
  const h = harness();
  h.config.readApiKey = () => 'sk-proj-fake-SHOULDNEVERAPPEAR-0000000000';
  const result = await run(h);
  const text = fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8');
  assert.ok(!text.includes('SHOULDNEVERAPPEAR'));
});

test('exactly one planning call per task (B13)', async () => {
  let planCalls = 0;
  const h = harness({
    planTask: async () => {
      planCalls += 1;
      return { taskSpec: validSpec() };
    },
    runGates: fakeGates([false, false, false, true]),
    reviewWork: fakeReviewer(['repair', 'repair', 'repair', 'accept']),
  });
  await run(h);
  assert.equal(planCalls, 1, 'repairs must not re-plan');
});
