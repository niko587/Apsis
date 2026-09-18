/**
 * Preflight. Answers "would a run work?" without starting one.
 *
 * The OpenAI check is opt-in behind `--check-openai`, and even then it is a
 * metadata read (`GET /v1/models/<id>`) rather than a generation: it proves the
 * key is valid and the model name resolves, and it produces no output tokens.
 * A doctor that quietly costs money is a doctor people stop running.
 *
 * The key is reported as present or missing. Never printed, never prefixed,
 * never length-hinted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { claudeAvailable, supportsResume, WORKER_TOOLS, WORKER_DENIED_TOOLS } from './claude.mjs';
import { ANTHROPIC_OPT_IN } from './child-env.mjs';
import { checkAccess } from './openai.mjs';
import { defaultGit } from './git.mjs';
import { RUNTIME_DIR } from './run-state.mjs';
import { AutopilotError } from './errors.mjs';

export const MIN_NODE_MAJOR = 22;

const ok = (name, detail) => ({ name, ok: true, detail });
const bad = (name, detail) => ({ name, ok: false, detail });
const warn = (name, detail) => ({ name, ok: true, warn: true, detail });

export async function doctor({
  config,
  cwd = process.cwd(),
  checkOpenAI = false,
  git = defaultGit,
  claudeImpl = claudeAvailable,
  resumeImpl = supportsResume,
  accessImpl = checkAccess,
  fsImpl = fs,
  nodeVersion = process.version,
} = {}) {
  const checks = [];

  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? ok('node', `${nodeVersion} (>= ${MIN_NODE_MAJOR})`)
      : bad('node', `${nodeVersion} — Autopilot needs Node ${MIN_NODE_MAJOR}+ for built-in fetch and node:test`),
  );

  let root = null;
  try {
    root = await git.repoRoot(cwd);
    checks.push(ok('repository', root));
  } catch (error) {
    checks.push(bad('repository', error.message));
  }

  try {
    checks.push(ok('git', (await git.version()).trim()));
  } catch (error) {
    checks.push(bad('git', error.message));
  }

  if (root) {
    try {
      const branch = await git.currentBranch(root);
      const head = await git.headSha(root);
      checks.push(ok('branch', `${branch} @ ${head.slice(0, 12)}`));
    } catch (error) {
      checks.push(bad('branch', error.message));
    }

    try {
      const clean = await git.isClean(root);
      checks.push(
        clean
          ? ok('working tree', 'clean')
          : bad('working tree', 'uncommitted changes — commit or stash before running'),
      );
    } catch (error) {
      checks.push(bad('working tree', error.message));
    }

    const runtime = path.join(root, RUNTIME_DIR);
    try {
      fsImpl.mkdirSync(runtime, { recursive: true });
      const probe = path.join(runtime, '.write-probe');
      fsImpl.writeFileSync(probe, 'ok');
      fsImpl.unlinkSync(probe);
      checks.push(ok('runtime directory', `${RUNTIME_DIR}/ writable`));
    } catch (error) {
      checks.push(bad('runtime directory', `${RUNTIME_DIR}/ is not writable: ${error.message}`));
    }

    const ignore = path.join(root, '.gitignore');
    const ignored =
      fsImpl.existsSync(ignore) && fsImpl.readFileSync(ignore, 'utf8').includes(RUNTIME_DIR);
    checks.push(
      ignored
        ? ok('gitignore', `${RUNTIME_DIR}/ is ignored`)
        : bad('gitignore', `${RUNTIME_DIR}/ is NOT ignored — run records would be committable`),
    );
  }

  const claude = await claudeImpl({ bin: config.claudeBin });
  checks.push(
    claude.ok
      ? ok('claude cli', `${config.claudeBin} — ${claude.version}`)
      : bad('claude cli', `"${config.claudeBin}" not runnable: ${claude.error ?? 'unknown'}`),
  );
  if (claude.ok) {
    const resume = await resumeImpl({ bin: config.claudeBin });
    checks.push(
      resume
        ? ok('claude resume', '--resume available; repair turns continue the same session')
        : warn('claude resume', '--resume not found; repair turns will start fresh with full context'),
    );
  }

  checks.push(ok('worker model', config.claudeModel));
  checks.push(
    ok(
      'worker tools',
      `${WORKER_TOOLS.join(', ')} — ${WORKER_DENIED_TOOLS.join('/')} denied, project settings only (D63)`,
    ),
  );
  checks.push(
    config.workerBudgetUsd === null
      ? warn(
          'worker budget',
          'APSIS_AUTOPILOT_WORKER_BUDGET_USD not set — `plan` and `dry-run` work; a real `run` will refuse to start',
        )
      : ok('worker budget', `$${config.workerBudgetUsd} per worker turn (claude --max-budget-usd)`),
  );
  if ((process.env[ANTHROPIC_OPT_IN] ?? '') === '1') {
    checks.push(
      warn(
        'anthropic key',
        `${ANTHROPIC_OPT_IN}=1 — ANTHROPIC_API_KEY will be passed to the worker. Every other secret is still stripped.`,
      ),
    );
  }
  checks.push(ok('planner model', `${config.openaiModel} (reasoning effort: ${config.reasoningEffort})`));

  checks.push(
    config.hasApiKey
      ? ok('OPENAI_API_KEY', 'present in this shell')
      : bad('OPENAI_API_KEY', 'not set — export it locally; never commit it and never paste it into a chat'),
  );

  if (checkOpenAI) {
    if (!config.hasApiKey) {
      checks.push(bad('openai access', 'skipped — no key'));
    } else {
      try {
        await accessImpl({ apiKey: config.readApiKey(), model: config.openaiModel });
        checks.push(ok('openai access', `key valid, "${config.openaiModel}" reachable (metadata read, no tokens generated)`));
      } catch (error) {
        const detail = error instanceof AutopilotError ? `${error.code}: ${error.message}` : error.message;
        checks.push(bad('openai access', detail));
      }
    }
  } else {
    checks.push(warn('openai access', 'not checked — pass --check-openai to verify the key and model'));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatDoctor({ ok: allOk, checks }) {
  const lines = checks.map((c) => {
    const mark = c.ok ? (c.warn ? '~' : '+') : 'x';
    return `  ${mark} ${c.name.padEnd(20)} ${c.detail}`;
  });
  lines.push('');
  lines.push(allOk ? '  ready' : '  NOT ready — fix the lines marked x above');
  return lines.join('\n');
}
