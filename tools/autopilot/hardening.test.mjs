/**
 * The pre-live closeout, items 3–6 and 9: the gaps independent review found
 * between "the architecture is right" and "this can be pointed at a repository
 * unattended".
 *
 * Every one of these is a case where the previous version did something
 * reasonable-looking and wrong: a boundary check that stopped being true before
 * the commit, a reviewer told a file existed but not what was in it, a secret
 * assertion that could never fire, a tool surface inherited from a file the
 * tool does not own, and unbounded spend.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { runAutopilot, OUTCOMES } from './controller.mjs';
import { CODES } from './errors.mjs';
import { validSpec, validReview } from './schemas.test.mjs';
import { makeGit, isBinary } from './git.mjs';
import { buildArgs, WORKER_TOOLS, WORKER_DENIED_TOOLS } from './claude.mjs';
import { buildProjectPacket, PACKET_FILES } from './context.mjs';
import { buildReviewPacket } from './reviewer.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apsis-hardening-'));

/* ------------------------------------------------------------------ fakes */

function harness(over = {}) {
  const root = tmpRoot();
  const state = {
    root,
    clean: true,
    baseSha: 'a'.repeat(40),
    baseBranch: 'main',
    /** changedFiles answers from this queue, then repeats the last entry. */
    changedQueue: [['src/universe/UniverseOverlay.tsx']],
    unreviewable: [],
    commits: [],
    pushes: [],
    worktrees: [],
    ...(over.gitState ?? {}),
  };
  let changedCalls = 0;

  const git = {
    state,
    repoRoot: async () => root,
    isClean: async () => state.clean,
    statusPorcelain: async () => '',
    currentBranch: async () => state.baseBranch,
    headSha: async () => state.baseSha,
    revParse: async () => state.baseSha,
    recentLog: async () => 'abc1234 a commit',
    version: async () => 'git version 2.53.0',
    changedFiles: async () => {
      const i = Math.min(changedCalls, state.changedQueue.length - 1);
      changedCalls += 1;
      return state.changedQueue[i];
    },
    reviewDiff: async () => ({ text: 'diff', unreviewable: state.unreviewable, truncated: false }),
    addWorktree: async ({ dir, branch }) => {
      state.worktrees.push({ dir, branch });
      const full = path.join(root, dir);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },
    commitAll: async ({ message }) => {
      state.commits.push(message);
      return 'b'.repeat(40);
    },
    pushBranch: async ({ branch }) => {
      state.pushes.push(branch);
      return { remote: 'origin', branch };
    },
  };

  const gateCalls = [];
  const runGates = over.runGates ??
    (async (names) => {
      gateCalls.push(names);
      return { results: names.map((g) => ({ gate: g, ok: true, exitCode: 0, durationMs: 1, tail: '' })), ok: true, failed: [], skipped: [] };
    });
  runGates.calls = gateCalls;

  const reviewCalls = [];
  const reviewWork = over.reviewWork ??
    (async () => {
      reviewCalls.push('accept');
      return { review: validReview() };
    });
  reviewWork.calls = reviewCalls;

  const workerCalls = [];
  const runWorker = async (args) => {
    workerCalls.push(args);
    return { summary: 'did it', sessionId: 'sid', exitCode: 0, durationMs: 1, removedEnv: ['OPENAI_API_KEY'] };
  };
  runWorker.calls = workerCalls;

  const deps = {
    git,
    planTask: async () => ({ taskSpec: { ...validSpec(), ...(over.specOver ?? {}) } }),
    reviewWork,
    runWorker,
    runGates,
    supportsResume: async () => true,
    buildProjectPacket: async () => 'PACKET',
    log: () => {},
  };

  const config = {
    openaiModel: 'gpt-6-astra',
    reasoningEffort: 'high',
    claudeModel: 'claude-opus-5',
    claudeBin: 'claude',
    maxRepairCycles: 3,
    workerBudgetUsd: over.workerBudgetUsd === undefined ? 5 : over.workerBudgetUsd,
    gateTimeoutMs: 1000,
    workerTimeoutMs: 1000,
    hasApiKey: true,
    readApiKey: () => 'sk-fake-000000000000000000',
  };

  return { root, git, deps, config, runGates, reviewWork, runWorker };
}

const run = (h, options = {}) =>
  runAutopilot({ mode: 'run', ownerGoal: 'goal', config: h.config, cwd: h.root, ...options }, h.deps);

/* ============================================================ 3. BOUNDARY */

test('3. a gate that creates a forbidden file is caught by the SECOND boundary check', async () => {
  // The exact hole: boundary #1 passes, then `npm run build` (or a test, or a
  // tool) writes a file, and `git add -A` would have committed it with no
  // controller verdict on it at all.
  const h = harness({
    gitState: {
      changedQueue: [
        ['src/universe/UniverseOverlay.tsx'], // after the worker — clean
        ['src/universe/UniverseOverlay.tsx', 'src/ui/LeadList.tsx'], // after the gates — not
      ],
    },
    reviewWork: Object.assign(
      async () => ({ review: validReview({ verdict: 'accept' }) }),
      { calls: [] },
    ),
  });

  const result = await run(h);

  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.boundary.code, CODES.FORBIDDEN_FILE);
  assert.deepEqual(result.boundary.violations, ['src/ui/LeadList.tsx']);
  assert.equal(h.git.state.commits.length, 0, 'the forbidden file must not be committed');

  const record = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'));
  const checks = record.steps.filter((s) => s.name === 'boundary-checked');
  assert.ok(checks.some((c) => c.when === 'after-worker'));
  assert.ok(checks.some((c) => c.when === 'after-gates'), 'the post-gate check must have run');
});

test('3. review is not even asked about an out-of-bounds diff', async () => {
  const h = harness({
    gitState: {
      changedQueue: [['src/universe/UniverseOverlay.tsx'], ['src/ui/LeadList.tsx']],
    },
  });
  const result = await run(h);
  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  // No reviewer call was spent obtaining an opinion the controller must ignore.
  assert.equal(h.reviewWork.calls.length, 0);
  const record = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'));
  assert.ok(record.steps.some((s) => s.name === 'review-skipped'));
});

test('3. the PRE-COMMIT check catches a file that appears after the review', async () => {
  const h = harness({
    gitState: {
      changedQueue: [
        ['src/universe/UniverseOverlay.tsx'], // after worker
        ['src/universe/UniverseOverlay.tsx'], // after gates
        ['src/universe/UniverseOverlay.tsx', '.env.local'], // immediately before commit
      ],
    },
  });
  const result = await run(h);
  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.FORBIDDEN_FILE);
  assert.equal(h.git.state.commits.length, 0);

  const record = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'));
  assert.ok(
    record.steps.some((s) => s.name === 'boundary-checked' && s.when === 'pre-commit'),
    'a pre-commit check must exist — git add -A commits whatever is there at that instant',
  );
});

test('3. the surface committed must be the surface that was REVIEWED', async () => {
  // Inside the boundary, but not the same set: the review describes something
  // that is no longer what would be committed.
  const h = harness({
    gitState: {
      changedQueue: [
        ['src/universe/UniverseOverlay.tsx'],
        ['src/universe/UniverseOverlay.tsx'],
        ['src/universe/UniverseOverlay.tsx', 'src/universe/overlay.css'],
      ],
    },
  });
  const result = await run(h);
  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.SURFACE_DRIFT);
  assert.match(result.reason, /appeared: src\/universe\/overlay\.css/);
  assert.equal(h.git.state.commits.length, 0);
});

test('3. a stable, in-bounds surface still commits normally', async () => {
  const h = harness();
  const result = await run(h);
  assert.equal(result.outcome, OUTCOMES.READY);
  assert.equal(h.git.state.commits.length, 1);
});

/* ================================================= 4. REVIEWABLE NEW FILES */

const realGitRepo = async () => {
  const root = tmpRoot();
  const git = makeGit();
  await git.run(['init', '-q', '-b', 'main'], root);
  await git.run(['config', 'user.email', 'test@example.invalid'], root);
  await git.run(['config', 'user.name', 'Test'], root);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  await git.run(['add', '-A'], root);
  await git.run(['commit', '-q', '-m', 'seed'], root);
  const base = (await git.run(['rev-parse', 'HEAD'], root)).trim();
  return { root, git, base };
};

test('4. a new .ts file reaches the reviewer WITH ITS CONTENTS', async () => {
  const { root, git, base } = await realGitRepo();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'newModule.ts'),
    'export const distinctiveMarker = 42;\nexport function alsoThis() { return distinctiveMarker; }\n',
  );

  const diff = await git.reviewDiff(root, base);

  // This is the whole defect: it used to say "(new file, contents not inlined)".
  assert.ok(!diff.text.includes('contents not inlined'));
  assert.match(diff.text, /\+\+\+ b\/src\/newModule\.ts/);
  assert.match(diff.text, /\+export const distinctiveMarker = 42;/);
  assert.match(diff.text, /\+export function alsoThis/);
  assert.deepEqual(diff.unreviewable, []);
});

test('4. new .tsx and .mjs files are inlined too', async () => {
  const { root, git, base } = await realGitRepo();
  fs.writeFileSync(path.join(root, 'Widget.tsx'), 'export const Widget = () => <div>hi</div>;\n');
  fs.writeFileSync(path.join(root, 'script.mjs'), 'export const run = () => 1;\n');
  const diff = await git.reviewDiff(root, base);
  assert.match(diff.text, /\+export const Widget/);
  assert.match(diff.text, /\+export const run = \(\) => 1;/);
});

test('4. a binary file is NOT represented as reviewed text', async () => {
  const { root, git, base } = await realGitRepo();
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));

  const diff = await git.reviewDiff(root, base);
  assert.equal(diff.unreviewable.length, 1);
  assert.equal(diff.unreviewable[0].file, 'logo.png');
  assert.equal(diff.unreviewable[0].reason, 'binary');
  assert.match(diff.text, /NOT been reviewed/);
});

test('4. an oversized file is named explicitly rather than silently cut', async () => {
  const { root, git, base } = await realGitRepo();
  fs.writeFileSync(path.join(root, 'generated.ts'), `// ${'x'.repeat(200_000)}\n`);

  const diff = await git.reviewDiff(root, base, { maxFileBytes: 1000 });
  assert.equal(diff.unreviewable.length, 1);
  assert.equal(diff.unreviewable[0].reason, 'too-large-to-review');
  assert.match(diff.text, /generated\.ts — too-large-to-review/);
});

test('4. truncation is explicit, and names the file it gave up on', async () => {
  const { root, git, base } = await realGitRepo();
  fs.writeFileSync(path.join(root, 'a.ts'), `export const a = "${'a'.repeat(800)}";\n`);
  fs.writeFileSync(path.join(root, 'b.ts'), `export const b = "${'b'.repeat(800)}";\n`);

  const diff = await git.reviewDiff(root, base, { maxBytes: 1200, maxFileBytes: 64_000 });
  assert.equal(diff.truncated, true);
  assert.ok(diff.unreviewable.some((u) => u.reason === 'exceeded-diff-budget'));
});

test('4. producing the diff does NOT stage anything', async () => {
  const { root, git, base } = await realGitRepo();
  fs.writeFileSync(path.join(root, 'fresh.ts'), 'export const x = 1;\n');
  await git.reviewDiff(root, base);

  const staged = (await git.run(['diff', '--cached', '--name-only'], root)).trim();
  assert.equal(staged, '', 'the index of an unaccepted tree must not be mutated to make a diff');
});

test('4. unreviewable files ESCALATE the run regardless of the verdict', async () => {
  const h = harness({
    gitState: { unreviewable: [{ file: 'logo.png', reason: 'binary', bytes: 2048 }] },
  });
  const result = await run(h);
  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.UNREVIEWABLE);
  assert.match(result.reason, /logo\.png \(binary\)/);
  assert.equal(h.git.state.commits.length, 0);
});

test('4. the review packet TELLS the reviewer what it has not seen', () => {
  const packet = buildReviewPacket({
    taskSpec: validSpec(),
    baseSha: 'a'.repeat(40),
    branch: 'autopilot/task-0001-x',
    changedFiles: ['logo.png'],
    diff: 'diff',
    unreviewable: [{ file: 'logo.png', reason: 'binary', bytes: 2048 }],
    gateResults: { results: [], ok: true, failed: [], skipped: [] },
    boundary: { ok: true, code: null, violations: [], unlisted: [] },
    workerSummary: 'added a logo',
    iteration: 0,
  });
  assert.match(packet, /NOT REVIEWED/);
  assert.match(packet, /logo\.png — binary/);
  assert.match(packet, /You have not seen them/);
});

test('4. binary detection catches a NUL byte and lets ordinary text through', () => {
  assert.equal(isBinary(Buffer.from('export const x = 1;\n')), false);
  assert.equal(isBinary(Buffer.from([0x00, 0x01])), true);
  assert.equal(isBinary(Buffer.from([0xff, 0xfe, 0xfd])), true, 'invalid UTF-8 is not reviewable text');
});

/* ================================================== 5. SECRET ORDER (D64) */

test('5. a secret in an allow-listed context file ABORTS planning', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const leaked = 'zz-unknown-format-secret-value-8127364554';

  // The scenario: someone pasted a key into a project document. The packet
  // builder reads that document by design.
  fs.writeFileSync(path.join(root, 'docs', 'CURRENT_STATE.md'), `# state\n\nkey: ${leaked}\n`);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}');

  const env = { OPENAI_API_KEY: leaked };
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      buildProjectPacket({ root, ownerGoal: 'g', headSha: 'a', baseBranch: 'main', recentLog: '' }),
      /refusing to send 1 secret value/,
      'planning must ABORT, not scrub and continue',
    );
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test('5. the abort happens instead of a quiet [REDACTED] substitution', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const leaked = 'zz-unknown-format-secret-value-8127364554';
  fs.writeFileSync(path.join(root, 'docs', 'NEXT_ACTIONS.md'), `next: ${leaked}\n`);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}');

  const original = process.env.SOME_VENDOR_TOKEN;
  process.env.SOME_VENDOR_TOKEN = leaked;
  try {
    let packet = null;
    await assert.rejects(async () => {
      packet = await buildProjectPacket({ root, ownerGoal: 'g', headSha: 'a', baseBranch: 'main', recentLog: '' });
    });
    assert.equal(packet, null, 'no packet may be produced at all');
  } finally {
    if (original === undefined) delete process.env.SOME_VENDOR_TOKEN;
    else process.env.SOME_VENDOR_TOKEN = original;
  }
});

test('5. an ordinary packet is still built, and is still shape-redacted', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  // A credential-shaped string this process does NOT own: defence in depth
  // scrubs it, and there is nothing to abort over.
  fs.writeFileSync(path.join(root, 'docs', 'CURRENT_STATE.md'), '# state\n\nexample: sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"vitest"}}');

  const packet = await buildProjectPacket({ root, ownerGoal: 'g', headSha: 'a', baseBranch: 'main', recentLog: 'x' });
  assert.match(packet, /\[REDACTED\]/);
  assert.ok(!packet.includes('sk-ant-api03-ZZZZ'));
  assert.match(packet, /Owner goal/);
});

test('5. the allow-list still excludes anything env-shaped', () => {
  for (const file of PACKET_FILES) assert.ok(!/\.env/.test(file));
});

/* ============================================== 6. PINNED TOOL PERMISSIONS */

test('6. the worker tool surface is stated, not inherited', () => {
  const args = buildArgs({ sessionId: 's' });
  const tools = args[args.indexOf('--tools') + 1];
  assert.equal(tools, 'Read,Edit,Write,Glob,Grep');
  assert.deepEqual([...WORKER_TOOLS], ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
});

test('6. Bash is denied explicitly as well as omitted', () => {
  const args = buildArgs({ sessionId: 's' });
  const denied = args[args.indexOf('--disallowed-tools') + 1].split(',');
  assert.ok(denied.includes('Bash'), 'the worker has no shell in v1');
  assert.ok(!args[args.indexOf('--tools') + 1].split(',').includes('Bash'));
  assert.ok(WORKER_DENIED_TOOLS.includes('Bash'));
});

test('6. the owner\'s personal Claude settings cannot grant the worker anything', () => {
  // A developer who allowed `Bash(git *)` for their own interactive use must not
  // be silently granting it to an unattended worker.
  const args = buildArgs({ sessionId: 's' });
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.ok(args.includes('--strict-mcp-config'), 'and no MCP server arrives from a config file either');
});

test('6. bypassPermissions is refused outright', () => {
  assert.throws(() => buildArgs({ permissionMode: 'bypassPermissions' }), (e) => e.code === CODES.WORKER_FAILED);
});

test('6. no dangerous-skip flag can appear in the invocation', () => {
  const args = buildArgs({ sessionId: 's', model: 'claude-opus-5' }).join(' ');
  assert.ok(!args.includes('dangerously'));
  assert.ok(!args.includes('bypassPermissions'));
});

/* ============================================================= 9. BUDGET */

test('9. a real run REFUSES to start without an explicit worker budget', async () => {
  const h = harness({ workerBudgetUsd: null });
  await assert.rejects(run(h), (e) => {
    assert.equal(e.code, CODES.NO_BUDGET);
    assert.match(e.message, /APSIS_AUTOPILOT_WORKER_BUDGET_USD/);
    return true;
  });
  assert.equal(h.runWorker.calls.length, 0);
  assert.equal(h.git.state.worktrees.length, 0);
});

test('9. plan and dry-run do not require a budget — they invoke no worker', async () => {
  for (const mode of ['plan', 'dry-run']) {
    const h = harness({ workerBudgetUsd: null });
    const result = await run(h, { mode });
    assert.ok([OUTCOMES.PLANNED, OUTCOMES.DRY_RUN].includes(result.outcome), `${mode} should not need a budget`);
    assert.equal(h.runWorker.calls.length, 0);
  }
});

test('9. the budget reaches the worker as --max-budget-usd', async () => {
  const h = harness({ workerBudgetUsd: 3.5 });
  await run(h);
  assert.equal(h.runWorker.calls[0].maxBudgetUsd, 3.5);
  const args = buildArgs({ sessionId: 's', maxBudgetUsd: 3.5 });
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '3.5');
});

test('9. a dirty tree is still reported before the budget — it is the more actionable fix', async () => {
  const h = harness({ workerBudgetUsd: null, gitState: { clean: false } });
  await assert.rejects(run(h), (e) => e.code === CODES.DIRTY_TREE);
});
