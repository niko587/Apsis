/**
 * The final closeout: review integrity.
 *
 * Two gaps, both of the same family — the packet said "reviewed" about
 * something nobody read.
 *
 *   ITEM 2 — TRACKED files were one blob. `git diff BASE --` was run for
 *   everything tracked and the combined string sliced at the global budget, so
 *   a large tracked diff, a tracked binary change, or simply enough tracked
 *   changes could leave Astra holding half a file with nothing in
 *   `unreviewable` naming it. D65's rule is per FILE, not per provenance.
 *
 *   ITEM 3 — the pre-commit check compared the changed FILE SET. `foo.ts`
 *   reviewed as version A and committed as version B passes that check
 *   perfectly: same name, same set, different bytes. A review TOCTOU gap that
 *   comparing names cannot close.
 *
 * And ITEM 4 — a config knob that did nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { makeGit, reviewFingerprint, parseNumstatZ } from './git.mjs';
import { runAutopilot, OUTCOMES } from './controller.mjs';
import { CODES } from './errors.mjs';
import { validSpec, validReview } from './schemas.test.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apsis-review-'));

/** A real git repository with one commit, so tracked changes are real ones. */
async function repoWith(files) {
  const root = tmpRoot();
  const git = makeGit();
  await git.run(['init', '-q', '-b', 'main'], root);
  await git.run(['config', 'user.email', 'test@example.invalid'], root);
  await git.run(['config', 'user.name', 'Test'], root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  await git.run(['add', '-A'], root);
  await git.run(['commit', '-q', '-m', 'seed'], root);
  const base = (await git.run(['rev-parse', 'HEAD'], root)).trim();
  return { root, git, base };
}

const named = (diff, file) => diff.unreviewable.find((u) => u.file === file);

/* ================================== ITEM 2 — every changed file, both kinds */

test('2. a complete small TRACKED text diff reaches the reviewer in full', async () => {
  const { root, git, base } = await repoWith({ 'src/a.ts': 'export const a = 1;\n' });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\nexport const b = 3;\n');

  const diff = await git.reviewDiff(root, base);
  assert.deepEqual(diff.unreviewable, []);
  assert.match(diff.text, /-export const a = 1;/);
  assert.match(diff.text, /\+export const a = 2;/);
  assert.match(diff.text, /\+export const b = 3;/);
  assert.deepEqual(diff.files, ['src/a.ts']);
});

test('2. a TRACKED binary modification is unreviewable, not a wall of mojibake', async () => {
  const { root, git, base } = await repoWith({ 'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x01]) });
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03, 0x04]));

  const diff = await git.reviewDiff(root, base);
  // git's own --numstat says binary; that beats guessing.
  assert.equal(named(diff, 'logo.png')?.reason, 'binary');
  assert.ok(!diff.text.includes('@@'), 'no hunk may be presented for a binary change');
  assert.match(diff.text, /NOT been reviewed/);
});

test('2. an OVERSIZED tracked text diff is named, never half-included', async () => {
  const { root, git, base } = await repoWith({ 'gen.ts': 'export const seed = 0;\n' });
  const huge = Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(root, 'gen.ts'), `${huge}\n`);

  const diff = await git.reviewDiff(root, base, { maxFileBytes: 2000 });
  assert.equal(named(diff, 'gen.ts')?.reason, 'too-large-to-review');
  assert.equal(diff.truncated, true);
  assert.ok(!diff.text.includes('export const v3999'), 'no partial content may leak in');
});

test('2. a tracked diff over the GLOBAL budget is named rather than cut in half', async () => {
  const { root, git, base } = await repoWith({ 'a.ts': 'x\n', 'b.ts': 'y\n' });
  const body = (c) => `${Array.from({ length: 200 }, (_, i) => `const ${c}${i} = ${i};`).join('\n')}\n`;
  fs.writeFileSync(path.join(root, 'a.ts'), body('a'));
  fs.writeFileSync(path.join(root, 'b.ts'), body('b'));

  // Room for roughly the first file only.
  const diff = await git.reviewDiff(root, base, { maxBytes: 4200, maxFileBytes: 64_000 });

  // The rule, stated as an assertion: every changed file is either COMPLETE in
  // the text or named in unreviewable. No third state.
  for (const file of diff.files) {
    const inText = diff.text.includes(`b/${file}`);
    const inUnreviewable = Boolean(named(diff, file));
    assert.notEqual(inText && inUnreviewable, true, `${file} is in both`);
    assert.ok(inText || inUnreviewable, `${file} is in neither — that is the third state`);
  }
  assert.ok(diff.unreviewable.length >= 1, 'the budget was too small for both files');
  assert.equal(named(diff, 'b.ts')?.reason, 'exceeded-diff-budget');
  assert.equal(diff.truncated, true);
});

test('2. when only the first files fit, the ones that fit are COMPLETE', async () => {
  const { root, git, base } = await repoWith({ 'a.ts': 'x\n', 'b.ts': 'y\n', 'c.ts': 'z\n' });
  const body = (c) => `${Array.from({ length: 120 }, (_, i) => `const ${c}${i} = ${i};`).join('\n')}\n`;
  for (const c of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, `${c}.ts`), body(c));

  const diff = await git.reviewDiff(root, base, { maxBytes: 3000 });
  const included = diff.files.filter((f) => !named(diff, f));
  assert.ok(included.length >= 1 && included.length < 3, `expected a partial fit, got ${included.length}/3`);

  for (const file of included) {
    const marker = file[0];
    // The LAST line of that file must be present: a file that is 90% included
    // reads as reviewed, which is the failure mode being excluded.
    assert.ok(diff.text.includes(`const ${marker}119 = 119;`), `${file} was included but truncated`);
  }
});

test('2. a tracked DELETION is reviewable — the removed text is the thing to read', async () => {
  const { root, git, base } = await repoWith({ 'gone.ts': 'export const secretLogic = 42;\n' });
  fs.unlinkSync(path.join(root, 'gone.ts'));

  const diff = await git.reviewDiff(root, base);
  assert.deepEqual(diff.unreviewable, []);
  assert.match(diff.text, /deleted file/);
  assert.match(diff.text, /-export const secretLogic = 42;/);
  assert.ok(diff.files.includes('gone.ts'));
});

test('2. a tracked RENAME is enumerated once and reviewable', async () => {
  const { root, git, base } = await repoWith({ 'old.ts': 'export const keep = 1;\n' });
  fs.renameSync(path.join(root, 'old.ts'), path.join(root, 'new.ts'));
  // Rename detection needs the change staged or committed to pair the paths;
  // reviewDiff must cope with the worktree as it finds it either way.
  await makeGit().run(['add', '-A'], root);

  const diff = await git.reviewDiff(root, base);
  assert.deepEqual(diff.unreviewable, []);
  assert.ok(diff.files.includes('new.ts'));
  assert.equal(diff.files.filter((f) => f === 'new.ts').length, 1, 'a rename is one entry, not two');
  assert.match(diff.text, /old\.ts/);
});

test('2. tracked and untracked changes are budgeted in ONE pass', async () => {
  const { root, git, base } = await repoWith({ 'tracked.ts': 'export const t = 1;\n' });
  fs.writeFileSync(path.join(root, 'tracked.ts'), 'export const t = 2;\n');
  fs.writeFileSync(path.join(root, 'fresh.ts'), 'export const f = 3;\n');

  const diff = await git.reviewDiff(root, base);
  assert.deepEqual(diff.unreviewable, []);
  assert.match(diff.text, /\+export const t = 2;/, 'tracked edit present');
  assert.match(diff.text, /\+export const f = 3;/, 'untracked addition present');
  assert.deepEqual(diff.files, ['fresh.ts', 'tracked.ts'], 'deterministic order, both kinds together');
});

test('2. a filename containing a newline does not derail enumeration', () => {
  // The reason --numstat is parsed with -z. A \n-splitting parser gets this
  // wrong, and getting a path wrong here means budgeting the wrong file.
  const entries = parseNumstatZ('1\t0\tweird\nname.ts\0-\t-\tlogo.png\0');
  assert.deepEqual(entries.map((e) => e.path), ['weird\nname.ts', 'logo.png']);
  assert.equal(entries[1].binary, true);
});

/* ============================== ITEM 3 — the bytes, not just the filenames */

test('3. the fingerprint is stable for the same review and moves for a different one', () => {
  const a = reviewFingerprint({ changedFiles: ['a.ts', 'b.ts'], text: 'diff', unreviewable: [] });
  const b = reviewFingerprint({ changedFiles: ['b.ts', 'a.ts'], text: 'diff', unreviewable: [] });
  assert.equal(a, b, 'file order must not change the fingerprint');

  assert.notEqual(a, reviewFingerprint({ changedFiles: ['a.ts', 'b.ts'], text: 'diff!', unreviewable: [] }));
  assert.notEqual(a, reviewFingerprint({ changedFiles: ['a.ts'], text: 'diff', unreviewable: [] }));
  assert.notEqual(
    a,
    reviewFingerprint({ changedFiles: ['a.ts', 'b.ts'], text: 'diff', unreviewable: [{ file: 'x', reason: 'binary', bytes: 1 }] }),
  );
  assert.match(a, /^[0-9a-f]{64}$/);
});

/**
 * The controller harness for the drift cases: the file SET is constant, only
 * the review text changes between the review call and the pre-commit rebuild.
 */
function driftHarness({ diffTexts, configMaxRepairs, specMaxRepairs } = {}) {
  const root = tmpRoot();
  const state = { commits: [], worktrees: [] };
  let diffCalls = 0;

  const changed = ['src/universe/UniverseOverlay.tsx'];
  const git = {
    state,
    repoRoot: async () => root,
    isClean: async () => true,
    statusPorcelain: async () => '',
    currentBranch: async () => 'main',
    headSha: async () => 'a'.repeat(40),
    revParse: async () => 'a'.repeat(40),
    recentLog: async () => 'abc a commit',
    version: async () => 'git version 2.53.0',
    changedFiles: async () => [...changed],
    reviewDiff: async () => {
      const i = Math.min(diffCalls, (diffTexts?.length ?? 1) - 1);
      diffCalls += 1;
      return { text: (diffTexts ?? ['same'])[i], unreviewable: [], truncated: false, files: [...changed] };
    },
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
    pushBranch: async ({ branch }) => ({ remote: 'origin', branch }),
  };

  const workerCalls = [];
  const runWorker = async (args) => {
    workerCalls.push(args);
    return { summary: 'did it', sessionId: 'sid', exitCode: 0, durationMs: 1, removedEnv: [] };
  };
  runWorker.calls = workerCalls;

  const gateCalls = [];
  const gateOk = specMaxRepairs === undefined && configMaxRepairs === undefined;
  const runGates = async (names) => {
    gateCalls.push(names);
    return gateOk
      ? { results: names.map((g) => ({ gate: g, ok: true, exitCode: 0, durationMs: 1, tail: '' })), ok: true, failed: [], skipped: [] }
      : { results: [{ gate: names[0], ok: false, exitCode: 1, durationMs: 1, tail: 'boom' }], ok: false, failed: [names[0]], skipped: names.slice(1) };
  };
  runGates.calls = gateCalls;

  const reviewCalls = [];
  const reviewWork = async () => {
    reviewCalls.push(1);
    return { review: validReview(gateOk ? {} : { verdict: 'repair', repairPrompt: 'fix it' }) };
  };
  reviewWork.calls = reviewCalls;

  const deps = {
    git,
    planTask: async () => ({
      taskSpec: { ...validSpec(), ...(specMaxRepairs === undefined ? {} : { maxRepairCycles: specMaxRepairs }) },
    }),
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
    maxRepairCycles: configMaxRepairs ?? 3,
    workerBudgetUsd: 5,
    gateTimeoutMs: 1000,
    workerTimeoutMs: 1000,
    hasApiKey: true,
    readApiKey: () => 'sk-fake-000000000000000000',
  };

  return { root, git, deps, config, runWorker, runGates, reviewWork };
}

const runIt = (h) =>
  runAutopilot({ mode: 'run', ownerGoal: 'goal', config: h.config, cwd: h.root }, h.deps);

test('3. foo.ts reviewed as A and changed to B before commit REFUSES to commit', async () => {
  // Same filename, same file set, different bytes. The set comparison is blind
  // to this; the fingerprint is not.
  const h = driftHarness({ diffTexts: ['version A of foo.ts', 'version B of foo.ts'] });
  const result = await runIt(h);

  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.CONTENT_DRIFT);
  assert.match(result.reason, /file names match but the contents do not/);
  assert.equal(h.git.state.commits.length, 0, 'bytes nobody reviewed must not be committed');
});

test('3. an unchanged worktree commits normally, and the fingerprints are recorded', async () => {
  const h = driftHarness({ diffTexts: ['version A of foo.ts'] });
  const result = await runIt(h);

  assert.equal(result.outcome, OUTCOMES.READY);
  assert.equal(h.git.state.commits.length, 1);

  const record = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'));
  const step = record.steps.find((s) => s.name === 'fingerprint-checked');
  assert.ok(step, 'the check must be visible in the run record');
  assert.equal(step.match, true);
  assert.equal(step.reviewed, step.final);
  assert.match(step.reviewed, /^[0-9a-f]{64}$/);
});

test('3. the fingerprint covers unreviewable metadata too', () => {
  const withBinary = reviewFingerprint({
    changedFiles: ['a.ts', 'logo.png'],
    text: 'diff',
    unreviewable: [{ file: 'logo.png', reason: 'binary', bytes: 10 }],
  });
  const withOversize = reviewFingerprint({
    changedFiles: ['a.ts', 'logo.png'],
    text: 'diff',
    unreviewable: [{ file: 'logo.png', reason: 'too-large-to-review', bytes: 10 }],
  });
  assert.notEqual(withBinary, withOversize, 'why a file was unreviewable is part of what was reviewed');
});

/* ================================= ITEM 4 — a knob that actually does something */

test('4. an owner-configured LOWER repair limit beats the TaskSpec', async () => {
  // APSIS_AUTOPILOT_MAX_REPAIRS=1 while Astra asks for 3.
  const h = driftHarness({ configMaxRepairs: 1, specMaxRepairs: 3 });
  const result = await runIt(h);

  assert.equal(result.outcome, OUTCOMES.ESCALATED);
  assert.equal(result.code, CODES.REPAIR_LIMIT);
  assert.match(result.reason, /repair limit reached \(1\)/);
  // Turn 0 plus exactly one repair. Not three.
  assert.equal(h.runWorker.calls.length, 2);
});

test('4. the TaskSpec still wins when IT is the lower of the two', async () => {
  const h = driftHarness({ configMaxRepairs: 3, specMaxRepairs: 0 });
  const result = await runIt(h);
  assert.equal(result.code, CODES.REPAIR_LIMIT);
  assert.match(result.reason, /repair limit reached \(0\)/);
  assert.equal(h.runWorker.calls.length, 1, 'zero repairs means one worker turn');
});

test('4. neither side can exceed the system ceiling of 3', async () => {
  const h = driftHarness({ configMaxRepairs: 99, specMaxRepairs: 3 });
  const result = await runIt(h);
  assert.match(result.reason, /repair limit reached \(3\)/);
  assert.equal(h.runWorker.calls.length, 4, 'turn 0 plus three repairs');
});

test('4. the effective limit is recorded, with the three inputs that produced it', async () => {
  const h = driftHarness({ configMaxRepairs: 1, specMaxRepairs: 3 });
  const result = await runIt(h);
  const record = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'));
  const step = record.steps.find((s) => s.name === 'repair-limit');
  assert.deepEqual(
    { taskSpec: step.taskSpec, config: step.config, ceiling: step.ceiling, effective: step.effective },
    { taskSpec: 3, config: 1, ceiling: 3, effective: 1 },
  );
});

test('4. the repair prompt quotes the EFFECTIVE limit, not the TaskSpec one', async () => {
  const h = driftHarness({ configMaxRepairs: 1, specMaxRepairs: 3 });
  await runIt(h);
  const repairTurn = h.runWorker.calls[1];
  assert.match(repairTurn.prompt, /repair turn 1 of 1/, 'telling the worker "of 3" when it gets 1 is a lie');
});
