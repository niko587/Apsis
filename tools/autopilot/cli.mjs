#!/usr/bin/env node
/**
 * Autopilot CLI.
 *
 *   npm run autopilot -- doctor [--check-openai]
 *   npm run autopilot -- plan    --goal "..."        GPT plans; nothing is run
 *   npm run autopilot -- dry-run --goal "..."        shows the run; touches nothing
 *   npm run autopilot -- run     --goal "..."        the full supervised loop
 *
 * A run ends at TASK READY FOR OWNER APPROVAL and prints the merge command.
 * It does not merge, and it does not push unless `--push-branch` is given.
 */

import fs from 'node:fs';
import process from 'node:process';
import { loadConfig, describeConfig } from './config.mjs';
import { doctor, formatDoctor } from './doctor.mjs';
import { runAutopilot, OUTCOMES } from './controller.mjs';
import { AutopilotError } from './errors.mjs';
import { redact } from './redaction.mjs';
import { defaultGit } from './git.mjs';
import { DEFAULT_OWNER_GOAL } from './policy.mjs';

const MODES = new Set(['doctor', 'plan', 'run', 'dry-run']);

export function parseArgv(argv) {
  const args = [...argv];
  let mode = 'run';
  if (args.length > 0 && !args[0].startsWith('-')) {
    mode = args.shift();
  }

  const flags = { checkOpenAI: false, pushBranch: false, goal: null, goalFile: null, maxTasks: null };
  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case '--check-openai':
        flags.checkOpenAI = true;
        break;
      case '--push-branch':
        flags.pushBranch = true;
        break;
      case '--goal':
        flags.goal = args.shift() ?? null;
        break;
      case '--goal-file':
        flags.goalFile = args.shift() ?? null;
        break;
      case '--max-tasks':
        flags.maxTasks = Number.parseInt(args.shift() ?? '', 10);
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  if (!MODES.has(mode)) throw new Error(`unknown mode "${mode}" — one of: ${[...MODES].join(', ')}`);
  return { mode, flags };
}

export function resolveGoal({ goal, goalFile }, { root, fsImpl = fs } = {}) {
  if (goal && goal.trim() !== '') return goal.trim();
  const file = goalFile ?? (root ? `${root}/.autopilot-goal` : null);
  if (file && fsImpl.existsSync(file)) {
    const text = fsImpl.readFileSync(file, 'utf8').trim();
    if (text !== '') return text;
  }
  return DEFAULT_OWNER_GOAL;
}

const USAGE = `Apsis Autopilot — GPT plans and reviews, Claude Code implements,
the controller runs the tests and enforces the boundaries, the owner merges.

  npm run autopilot -- doctor [--check-openai]
  npm run autopilot -- plan    --goal "finish prototype polish"
  npm run autopilot -- dry-run --goal "finish prototype polish"
  npm run autopilot -- run     --goal "finish prototype polish" [--push-branch]

  --goal <text>       the owner goal; outranks any model-generated roadmap
  --goal-file <path>  read the goal from a file (default: .autopilot-goal)
  --check-openai      doctor only: verify the key and model with a metadata read
  --push-branch       run only: push the task branch (never main, never forced)

No mode merges anything. A finished run prints the merge command for you to run.`;

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  const { mode, flags } = parsed;
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let root = process.cwd();
  try {
    root = await defaultGit.repoRoot(process.cwd());
  } catch {
    // doctor reports this properly; other modes fail in the controller.
  }

  const config = loadConfig({ cwd: process.cwd(), repoRoot: root });

  if (mode === 'doctor') {
    const report = await doctor({ config, cwd: process.cwd(), checkOpenAI: flags.checkOpenAI });
    process.stdout.write(`\nApsis Autopilot — doctor\n\n${formatDoctor(report)}\n\n`);
    return report.ok ? 0 : 1;
  }

  const ownerGoal = resolveGoal(flags, { root });

  if (!config.hasApiKey) {
    process.stderr.write(
      '\nOPENAI_API_KEY is not set in this shell.\n\n' +
        '  export OPENAI_API_KEY=...        (your own key, locally)\n\n' +
        'Never commit it, and never paste it into a chat. See tools/autopilot/README.md.\n\n',
    );
    return 1;
  }

  process.stdout.write(`\nApsis Autopilot — ${mode}\n`);
  process.stdout.write(`  goal: ${ownerGoal}\n`);
  process.stdout.write(`  ${JSON.stringify(describeConfig(config))}\n\n`);

  try {
    const result = await runAutopilot({
      mode,
      ownerGoal,
      config,
      pushBranch: flags.pushBranch,
      cwd: process.cwd(),
    });
    process.stdout.write(`${format(result, root)}\n`);
    return result.outcome === OUTCOMES.ESCALATED ? 3 : 0;
  } catch (error) {
    const code = error instanceof AutopilotError ? error.code : 'unexpected';
    process.stderr.write(`\nAutopilot stopped: [${code}] ${redact(error.message)}\n\n`);
    return 1;
  }
}

function format(result, root) {
  const lines = [];
  const spec = result.taskSpec;

  if (result.outcome === OUTCOMES.PLANNED) {
    lines.push('TASK PLANNED (nothing was created, no worker was invoked)', '');
    lines.push(JSON.stringify(spec, null, 2));
    lines.push('', `saved: ${result.runDir}/planner.json`);
    return lines.join('\n');
  }

  if (result.outcome === OUTCOMES.DRY_RUN) {
    lines.push('DRY RUN — no branch, no worktree, no worker, no git mutation', '');
    lines.push(`  task:      ${spec.taskId} — ${spec.title}`);
    lines.push(`  would branch: ${result.wouldCreate.branch} from ${result.wouldCreate.baseSha.slice(0, 12)}`);
    lines.push(`  would worktree: ${result.wouldCreate.worktree}`);
    lines.push(`  would invoke: ${result.wouldInvoke.bin} (${result.wouldInvoke.model})`);
    lines.push(`  would gate:   ${result.wouldRun.join(', ')}`);
    lines.push(`  allowed:      ${spec.allowedFiles.join(', ')}`);
    lines.push(`  forbidden:    ${spec.forbiddenFiles.join(', ') || '(spec adds none; controller list still applies)'}`);
    lines.push('', `saved: ${result.runDir}/`);
    return lines.join('\n');
  }

  if (result.outcome === OUTCOMES.ESCALATED) {
    lines.push('TASK ESCALATED — not merged, not pushed', '');
    lines.push(`  reason:  ${result.reason}`);
    if (result.code) lines.push(`  code:    ${result.code}`);
    if (spec) lines.push(`  task:    ${spec.taskId} — ${spec.title}`);
    if (result.branch) lines.push(`  branch:  ${result.branch}`);
    if (result.gateResults?.failed?.length) lines.push(`  gates failed: ${result.gateResults.failed.join(', ')}`);
    if (result.boundary && !result.boundary.ok) {
      lines.push(`  boundary: ${result.boundary.code}`);
      if (result.boundary.violations.length) lines.push(`    forbidden: ${result.boundary.violations.join(', ')}`);
      if (result.boundary.unlisted.length) lines.push(`    unlisted:  ${result.boundary.unlisted.join(', ')}`);
    }
    if (result.review?.ownerAttention) lines.push(`  owner:   ${result.review.ownerAttention}`);
    lines.push('', `  run record: ${result.runDir}/`);
    lines.push(`  the work is still on ${result.branch ?? '(no branch)'} — inspect it before deciding.`);
    return lines.join('\n');
  }

  lines.push('TASK READY FOR OWNER APPROVAL', '');
  lines.push(`  task:    ${spec.taskId} — ${spec.title}`);
  lines.push(`  branch:  ${result.branch}`);
  lines.push(`  base:    ${result.baseBranch} @ ${result.baseSha}`);
  lines.push(`  head:    ${result.headSha}`);
  lines.push(`  gates:   PASS (${result.gateResults.results.map((r) => r.gate).join(', ')})`);
  lines.push(`  review:  ACCEPT`);
  lines.push('');
  lines.push(`  changed files (${result.changedFiles.length}):`);
  for (const file of result.changedFiles) lines.push(`    ${file}`);
  lines.push('');
  if (result.review?.summary) lines.push(`  reviewer: ${result.review.summary}`);
  if (result.review?.ownerAttention) lines.push(`  owner:    ${result.review.ownerAttention}`);
  lines.push('');
  lines.push(`  run record: ${result.runDir}/`);
  lines.push(result.pushed ? `  pushed:   ${result.pushed.remote}/${result.pushed.branch}` : '  pushed:   no (pass --push-branch to push the task branch)');
  lines.push('');
  lines.push('  Autopilot does not merge. To take the work:');
  lines.push('');
  lines.push(`      ${result.mergeCommand}`);
  lines.push('');
  lines.push('  To discard it:');
  lines.push('');
  lines.push(`      git -C ${root} worktree remove --force ${result.worktree}`);
  lines.push(`      git -C ${root} branch -D ${result.branch}`);
  return lines.join('\n');
}

/* Run only when invoked directly, so the tests can import this module. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
