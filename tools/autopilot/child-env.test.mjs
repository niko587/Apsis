/**
 * The pre-live closeout, items 1 and 2: neither child process gets the owner's
 * credentials.
 *
 * The values below are FAKE. No real key appears in this repository.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { sanitizedChildEnv, workerEnv, gateEnv, ANTHROPIC_OPT_IN, NAME_EXEMPTIONS } from './child-env.mjs';
import { runWorker } from './claude.mjs';
import { runGate } from './gates.mjs';

const FAKE_OPENAI = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_ANTHROPIC = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const FAKE_GITHUB = 'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** A realistic developer shell: ordinary variables and several credentials. */
const shell = (extra = {}) => ({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/owner',
  USER: 'owner',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/var/folders/tmp/',
  NODE_OPTIONS: '--max-old-space-size=4096',
  SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
  npm_config_registry: 'https://registry.npmjs.org/',

  OPENAI_API_KEY: FAKE_OPENAI,
  OPENAI_AUTOPILOT_MODEL: 'gpt-6-astra',
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
  GITHUB_TOKEN: FAKE_GITHUB,
  // Deliberately NOT a well-formed vendor key. An earlier version of this file
  // used a realistic `sk_test_…` shape and GitHub's push protection correctly
  // refused the push — a scanner cannot tell a fixture from a leak, and a
  // repository that teaches you to click "allow" is worse than one with a
  // slightly uglier fixture. This entry exercises removal by NAME, which is
  // what it is here for.
  WORKOS_API_KEY: 'fake-workos-value-for-tests-not-a-key',
  WORKOS_COOKIE_PASSWORD: 'a-very-long-cookie-password-value',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
  'npm_config_//registry.npmjs.org/:_authToken': 'npm_EEEEEEEEEEEEEEEEEEEEEEEE',
  APSIS_AUTOPILOT_WORKER_BUDGET_USD: '5',
  ...extra,
});

function fakeSpawn({ stdout = '', code = 0 } = {}) {
  const calls = [];
  const impl = (bin, args, options) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', code);
    });
    return child;
  };
  impl.calls = calls;
  return impl;
}

const workerPayload = JSON.stringify({
  is_error: false,
  result: 'done',
  session_id: '8f1d0e2a-0000-4000-8000-000000000001',
});

/* ------------------------------------------------------------ the utility */

test('1. OPENAI_API_KEY is removed — the other provider never sees this one', () => {
  const { env, removed } = sanitizedChildEnv({ source: shell() });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.ok(removed.includes('OPENAI_API_KEY'));
});

test('1. every secret-shaped NAME is removed', () => {
  const { env } = sanitizedChildEnv({ source: shell() });
  for (const name of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'WORKOS_API_KEY',
    'WORKOS_COOKIE_PASSWORD',
    'AWS_SECRET_ACCESS_KEY',
    'npm_config_//registry.npmjs.org/:_authToken',
  ]) {
    assert.equal(env[name], undefined, `${name} survived`);
  }
});

test('1. a credential with an INNOCUOUS name is removed by value shape', () => {
  // The case a name filter alone misses completely.
  const { env, removed } = sanitizedChildEnv({ source: shell({ MY_THING: FAKE_OPENAI, DEPLOY: FAKE_GITHUB }) });
  assert.equal(env.MY_THING, undefined);
  assert.equal(env.DEPLOY, undefined);
  assert.ok(removed.includes('MY_THING'));
});

test('1. a secret in an unknown format is removed by identity with a known one', () => {
  const odd = 'zz-format-nobody-here-has-heard-of-918273';
  const { env } = sanitizedChildEnv({ source: shell({ VENDOR_API_KEY: odd, COPY_OF_IT: odd }) });
  assert.equal(env.VENDOR_API_KEY, undefined, 'removed by name');
  assert.equal(env.COPY_OF_IT, undefined, 'and its twin removed by value');
});

test('1. the controller\'s own configuration does not leak into a child either', () => {
  const { env } = sanitizedChildEnv({ source: shell() });
  assert.equal(env.OPENAI_AUTOPILOT_MODEL, undefined);
  assert.equal(env.APSIS_AUTOPILOT_WORKER_BUDGET_USD, undefined);
});

test('2. ordinary environment survives — a gate still has to be able to run', () => {
  const { env } = gateEnv({ source: shell() });
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin');
  assert.equal(env.HOME, '/Users/owner');
  assert.equal(env.USER, 'owner');
  assert.equal(env.SHELL, '/bin/zsh');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.TMPDIR, '/var/folders/tmp/');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
});

test('2. SSH_AUTH_SOCK is exempt — it is a socket path, and git needs it', () => {
  const { env } = sanitizedChildEnv({ source: shell() });
  assert.equal(env.SSH_AUTH_SOCK, '/private/tmp/ssh-agent.sock');
  assert.ok(NAME_EXEMPTIONS.has('SSH_AUTH_SOCK'));
});

test('2. gates get CI=1 and FORCE_COLOR=0, which are configuration not credentials', () => {
  const { env } = gateEnv({ source: shell() });
  assert.equal(env.CI, '1');
  assert.equal(env.FORCE_COLOR, '0');
});

test('1. removed values are never returned — only names', () => {
  const { removed } = sanitizedChildEnv({ source: shell() });
  const text = JSON.stringify(removed);
  for (const secret of [FAKE_OPENAI, FAKE_ANTHROPIC, FAKE_GITHUB]) {
    assert.ok(!text.includes(secret), 'a value reached the removed list');
  }
});

test('1. ANTHROPIC_API_KEY comes back ONLY behind the narrow opt-in', () => {
  // v1 assumes the normal stored Claude login. An installation that needs an
  // env-carried key opts in by name — one variable, not a blanket pass-through.
  const without = workerEnv({ source: shell() });
  assert.equal(without.env.ANTHROPIC_API_KEY, undefined);

  const with_ = workerEnv({ source: shell({ [ANTHROPIC_OPT_IN]: '1' }) });
  assert.equal(with_.env.ANTHROPIC_API_KEY, FAKE_ANTHROPIC);

  // And the opt-in re-admits exactly that one variable, nothing else.
  assert.equal(with_.env.OPENAI_API_KEY, undefined);
  assert.equal(with_.env.GITHUB_TOKEN, undefined);
});

/* ------------------------------------------------- the actual child spawns */

test('1. the Claude worker child is spawned WITHOUT OPENAI_API_KEY', async () => {
  const spawnImpl = fakeSpawn({ stdout: workerPayload });
  await runWorker({ prompt: 'x', cwd: '/tmp/wt', spawnImpl, env: shell() });

  const [call] = spawnImpl.calls;
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
  assert.equal(call.options.env.GITHUB_TOKEN, undefined);
  assert.equal(call.options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.notEqual(call.options.env, process.env, 'must not be the live process env');

  // And it can still function: PATH and HOME are there.
  assert.equal(call.options.env.PATH, '/usr/local/bin:/usr/bin:/bin');
  assert.equal(call.options.env.HOME, '/Users/owner');

  // No value appears anywhere in the spawn options.
  assert.ok(!JSON.stringify(call.options).includes(FAKE_OPENAI));
});

test('1. the worker result reports removed NAMES, for the run record', async () => {
  const spawnImpl = fakeSpawn({ stdout: workerPayload });
  const result = await runWorker({ prompt: 'x', cwd: '/tmp/wt', spawnImpl, env: shell() });
  assert.ok(result.removedEnv.includes('OPENAI_API_KEY'));
  assert.ok(!JSON.stringify(result.removedEnv).includes(FAKE_OPENAI));
});

test('2. a gate child is spawned WITHOUT secrets but WITH a usable environment', async () => {
  // A gate runs code a model just wrote. It has never needed a credential.
  const spawnImpl = fakeSpawn({ stdout: '', code: 0 });
  await runGate('unit', { cwd: '/tmp/wt', spawnImpl, env: shell() });

  const [call] = spawnImpl.calls;
  assert.equal(call.bin, 'npm');
  assert.deepEqual(call.args, ['test'], 'the gate table decided this, not a model');
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.options.env.GITHUB_TOKEN, undefined);
  assert.equal(call.options.env['npm_config_//registry.npmjs.org/:_authToken'], undefined);

  assert.equal(call.options.env.PATH, '/usr/local/bin:/usr/bin:/bin');
  assert.equal(call.options.env.HOME, '/Users/owner');
  assert.equal(call.options.env.npm_config_registry, 'https://registry.npmjs.org/');
  assert.equal(call.options.env.CI, '1');
  assert.equal(call.options.shell, false);
});

test('2. every gate in the table is spawned with the same sanitised environment', async () => {
  for (const gate of ['typecheck', 'lint', 'unit', 'build', 'e2e']) {
    const spawnImpl = fakeSpawn({ stdout: '', code: 0 });
    await runGate(gate, { cwd: '/tmp/wt', spawnImpl, env: shell() });
    assert.equal(spawnImpl.calls[0].options.env.OPENAI_API_KEY, undefined, `${gate} inherited the key`);
  }
});
