/**
 * Tests 4, 8 and 19: the structural containment.
 *
 * Test 19 is the one to read carefully. `../` tricks are not exotic — a model
 * writing `src/../../etc/passwd` is a model being unhelpful, not hostile — but
 * the consequence of accepting one is that a branch name, a worktree directory
 * or a boundary check starts operating outside the repository.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSafeRepoPath,
  assertSafeRepoPaths,
  enforceBoundaries,
  globToRegExp,
  matchesAny,
  sanitiseSlug,
  branchNameFor,
  worktreeDirFor,
  ALWAYS_FORBIDDEN,
} from './boundaries.mjs';
import { CODES } from './errors.mjs';

const spec = {
  allowedFiles: ['src/universe/**', 'e2e/drill-dimensions.spec.ts'],
  forbiddenFiles: ['src/ui/LeadList.tsx'],
};

test('4. a change to a forbidden file rejects the task', () => {
  const verdict = enforceBoundaries({
    ...spec,
    changed: ['src/universe/UniverseOverlay.tsx', 'src/ui/LeadList.tsx'],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.FORBIDDEN_FILE);
  assert.deepEqual(verdict.violations, ['src/ui/LeadList.tsx']);
});

test('4. a change to an unlisted file rejects the task', () => {
  const verdict = enforceBoundaries({ ...spec, changed: ['src/state/store.ts'] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.UNLISTED_FILE);
  assert.deepEqual(verdict.unlisted, ['src/state/store.ts']);
});

test('4. a diff entirely inside the declared surface passes', () => {
  const verdict = enforceBoundaries({
    ...spec,
    changed: ['src/universe/UniverseOverlay.tsx', 'src/universe/overlay.css', 'e2e/drill-dimensions.spec.ts'],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, null);
});

test('4. the always-forbidden list applies even when the spec allows everything', () => {
  // The dangerous spec: a planner that writes `**` and means well.
  for (const file of ['.env', '.env.local', 'tools/autopilot/controller.mjs', '.apsis-autopilot/runs/x/run.json']) {
    const verdict = enforceBoundaries({ changed: [file], allowedFiles: ['**'], forbiddenFiles: [] });
    assert.equal(verdict.ok, false, `${file} must be refused`);
    assert.equal(verdict.code, CODES.FORBIDDEN_FILE);
  }
  assert.ok(ALWAYS_FORBIDDEN.includes('tools/autopilot/**'));
});

test('19. a path that escapes the repository is not a safe path', () => {
  const escapes = [
    '../secrets.txt',
    '../../etc/passwd',
    'src/../../etc/passwd',
    '/etc/passwd',
    '/Users/someone/.ssh/id_rsa',
    '~/.aws/credentials',
    'C:\\Windows\\System32',
    '..',
    'src/../..',
    'a/../../b',
    '.git/config',
    'src/.git/hooks/pre-commit',
    '',
  ];
  for (const candidate of escapes) {
    assert.equal(isSafeRepoPath(candidate), false, `${JSON.stringify(candidate)} must be unsafe`);
  }
  assert.equal(isSafeRepoPath('src/universe/clusters.ts'), true);
  assert.equal(isSafeRepoPath('src/universe/**'), true);
  assert.equal(isSafeRepoPath('docs/a/../b.md'), true, 'normalising inside the repo is fine');
});

test('19. a spec containing an escaping path is refused before anything uses it', () => {
  assert.throws(
    () => assertSafeRepoPaths(['src/ok.ts', '../../.ssh/id_rsa'], 'TaskSpec.allowedFiles'),
    (e) => e.code === CODES.UNSAFE_PATH,
  );
});

test('19. an escaping path in the DIFF is refused too, not merely in the spec', () => {
  const verdict = enforceBoundaries({ changed: ['../outside.txt'], allowedFiles: ['**'], forbiddenFiles: [] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.UNSAFE_PATH);
});

test('19. ORDER: the path check runs before the glob match, and must', () => {
  // `**` genuinely matches an escaping path — a glob matcher has no concept of
  // a repository root, and pretending otherwise would be the bug.
  assert.equal(matchesAny('../../etc/passwd', ['**']), true);

  // Which is exactly why enforceBoundaries asks "is this path expressible at
  // all" FIRST. Swap the two and `allowedFiles: ['**']` would wave the escape
  // straight through as allowed.
  const verdict = enforceBoundaries({ changed: ['../../etc/passwd'], allowedFiles: ['**'], forbiddenFiles: [] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.UNSAFE_PATH);
  assert.deepEqual(verdict.unsafe, ['../../etc/passwd']);
});

test('8. branch and worktree names are sanitised from the model-supplied taskId', () => {
  const nasty = 'Polish; rm -rf / --no-preserve-root `whoami` $(id) ../../escape';
  const branch = branchNameFor(1, nasty);
  assert.match(branch, /^autopilot\/task-0001-[a-z0-9-]+$/);
  assert.ok(!branch.includes('..'));
  assert.ok(!/[;`$()\s]/.test(branch));

  const dir = worktreeDirFor(1, nasty);
  assert.ok(dir.startsWith('.apsis-autopilot/worktrees/task-0001-'));
  assert.ok(!dir.includes('..'));
});

test('8. a taskId that sanitises to nothing still yields a usable ref', () => {
  for (const raw of ['', '///', '---', '@', '...', undefined, null]) {
    const branch = branchNameFor(7, raw);
    assert.match(branch, /^autopilot\/task-0007-[a-z0-9-]+$/, `got ${branch}`);
  }
  assert.equal(sanitiseSlug('a.lock'), 'a-lock');
});

test('8. git ref hazards are removed', () => {
  assert.equal(sanitiseSlug('-leading-dash'), 'leading-dash');
  assert.equal(sanitiseSlug('trailing-dash-'), 'trailing-dash');
  assert.equal(sanitiseSlug('UPPER Case Words'), 'upper-case-words');
  assert.ok(sanitiseSlug('x'.repeat(200)).length <= 48);
});

test('globToRegExp supports exactly the grammar a TaskSpec needs', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/**').test('src/a.ts'));
  assert.ok(globToRegExp('**/*.test.ts').test('server/auth/x.test.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.equal(globToRegExp('src/*.ts').test('src/a/b.ts'), false, '* must not cross a separator');
  assert.ok(globToRegExp('src/ui').test('src/ui/LeadList.tsx'), 'a directory covers its contents');
  assert.equal(globToRegExp('src/ui').test('src/universe/x.ts'), false);
  // Regex metacharacters in a glob are literal, not syntax.
  assert.ok(globToRegExp('docs/a+b.md').test('docs/a+b.md'));
  assert.equal(globToRegExp('docs/a+b.md').test('docs/aab.md'), false);
});
