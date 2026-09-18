/**
 * Test 17, and the adapter's own contract with the installed CLI.
 *
 * Nothing here runs `claude`. The invocation is asserted as data — which is the
 * only way to check it without starting a nested coding run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildArgs, parseResult, runWorker, supportsResume, claudeAvailable, DEFAULT_WORKER_MODEL } from './claude.mjs';
import { CODES } from './errors.mjs';

/** A spawn stand-in: scripted stdout/stderr/exit, and a recorder for argv. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, failToStart = false } = {}) {
  const calls = [];
  const impl = (bin, args, options) => {
    calls.push({ bin, args, options, stdin: '' });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: (data) => {
        calls[calls.length - 1].stdin = String(data ?? '');
      },
    };
    child.kill = () => {};
    queueMicrotask(() => {
      if (failToStart) {
        child.emit('error', new Error('spawn claude ENOENT'));
        return;
      }
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  impl.calls = calls;
  return impl;
}

const okPayload = (over = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 4,
    result: 'Implemented the empty state and ran the unit gate.',
    session_id: '8f1d0e2a-0000-4000-8000-000000000001',
    total_cost_usd: 0.42,
    ...over,
  });

test('the invocation matches the installed CLI (claude 2.1.x non-interactive)', () => {
  const args = buildArgs({ model: 'claude-opus-5', sessionId: 'sid', maxBudgetUsd: 5, addDir: '/tmp/wt' });
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'json',
    '--model',
    'claude-opus-5',
    '--permission-mode',
    'acceptEdits',
    '--session-id',
    'sid',
    '--max-budget-usd',
    '5',
    '--add-dir',
    '/tmp/wt',
  ]);
});

test('a repair turn resumes instead of choosing a new session id', () => {
  const args = buildArgs({ sessionId: 'sid', resumeSessionId: 'old' });
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'old');
  assert.ok(!args.includes('--session-id'), 'resume and session-id are mutually exclusive');
});

test('the default worker model is Opus 5, and fable is opt-in per task', () => {
  assert.equal(DEFAULT_WORKER_MODEL, 'claude-opus-5');
  assert.ok(buildArgs({ model: 'claude-fable-5' }).includes('claude-fable-5'));
});

test('the permission mode is acceptEdits, not bypassPermissions', () => {
  // Containment is the worktree, the boundary check and the gates — not a
  // permission prompt nobody is present to answer. But there is still no reason
  // to hand the worker the widest mode available.
  const args = buildArgs({});
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
});

test('the prompt goes in on stdin, never as an argv positional', async () => {
  const spawnImpl = fakeSpawn({ stdout: okPayload() });
  const prompt = 'a very long worker prompt '.repeat(500);
  await runWorker({ prompt, cwd: '/tmp/wt', spawnImpl });

  const [call] = spawnImpl.calls;
  assert.equal(call.stdin, prompt);
  assert.ok(!call.args.includes(prompt), 'argv has a length limit and shows up in ps');
  assert.equal(call.options.shell, false, 'no shell: nothing in the prompt can be syntax');
});

test('a successful turn yields the summary and the session id', async () => {
  const spawnImpl = fakeSpawn({ stdout: okPayload() });
  const result = await runWorker({ prompt: 'x', cwd: '/tmp/wt', spawnImpl });
  assert.match(result.summary, /Implemented the empty state/);
  assert.equal(result.sessionId, '8f1d0e2a-0000-4000-8000-000000000001');
  assert.equal(result.costUsd, 0.42);
});

test('17. a non-zero exit fails closed', async () => {
  const spawnImpl = fakeSpawn({ stdout: '', stderr: 'permission denied', code: 1 });
  await assert.rejects(runWorker({ prompt: 'x', cwd: '/tmp/wt', spawnImpl }), (e) => {
    assert.equal(e.code, CODES.WORKER_FAILED);
    return true;
  });
});

test('17. a missing binary is reported as a missing binary, not as a failed task', async () => {
  const spawnImpl = fakeSpawn({ failToStart: true });
  await assert.rejects(
    runWorker({ prompt: 'x', cwd: '/tmp/wt', bin: 'claude', spawnImpl }),
    (e) => e.code === CODES.CLAUDE_MISSING,
  );
});

test('17. unparseable stdout fails closed — never "it probably worked"', async () => {
  const spawnImpl = fakeSpawn({ stdout: 'Claude Code v9 output format changed\n' });
  await assert.rejects(
    runWorker({ prompt: 'x', cwd: '/tmp/wt', spawnImpl }),
    (e) => e.code === CODES.WORKER_MALFORMED,
  );
});

test('17. is_error true fails closed even with exit 0', async () => {
  const spawnImpl = fakeSpawn({ stdout: okPayload({ is_error: true, result: 'hit the budget cap' }) });
  await assert.rejects(
    runWorker({ prompt: 'x', cwd: '/tmp/wt', spawnImpl }),
    (e) => e.code === CODES.WORKER_FAILED,
  );
});

test('17. an empty summary fails closed', () => {
  assert.throws(() => parseResult(okPayload({ result: '   ' })), (e) => e.code === CODES.WORKER_MALFORMED);
});

test('the session id chosen up front survives an unparseable session_id field', async () => {
  // So an interrupted run still names something resumable.
  const spawnImpl = fakeSpawn({ stdout: okPayload({ session_id: 42 }) });
  const result = await runWorker({ prompt: 'x', cwd: '/tmp/wt', sessionId: 'chosen-id', spawnImpl });
  assert.equal(result.sessionId, 'chosen-id');
});

test('the worker summary is redacted before it is ever recorded', () => {
  const leaked = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const parsed = parseResult(okPayload({ result: `I found a key: ${leaked}` }));
  assert.ok(!parsed.summary.includes(leaked));
});

test('resume support is read from the installed binary, not assumed', async () => {
  assert.equal(await supportsResume({ execImpl: async () => ({ stdout: '  -r, --resume [value]  Resume' }) }), true);
  assert.equal(await supportsResume({ execImpl: async () => ({ stdout: '  -p, --print' }) }), false);
  assert.equal(
    await supportsResume({
      execImpl: async () => {
        throw new Error('ENOENT');
      },
    }),
    false,
    'an unavailable binary means no resume, not a crash',
  );
});

test('availability reports version without throwing when the binary is absent', async () => {
  const absent = await claudeAvailable({
    execImpl: async () => {
      throw new Error('spawn claude ENOENT');
    },
  });
  assert.equal(absent.ok, false);
  const present = await claudeAvailable({ execImpl: async () => ({ stdout: '2.1.234 (Claude Code)\n' }) });
  assert.deepEqual(present, { ok: true, version: '2.1.234 (Claude Code)' });
});
