/**
 * The project packet: a bounded, allow-listed view of the repository.
 *
 * The temptation is to send everything and let the model sort it out. Three
 * reasons not to, in ascending order of seriousness: cost, dilution, and the
 * fact that "everything" includes `.env.local`, `node_modules`, build output
 * and the IndexedDB fixtures. This module names the files it reads. Nothing
 * else is read — not "excluded by a filter", NOT READ.
 *
 * On top of that, `assertNoSecrets` runs on the assembled packet before it
 * leaves. If a secret ever makes it this far, the packet builder has a bug and
 * the run aborts rather than scrubbing and continuing, because scrubbing would
 * conceal the bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertNoSecrets, redact } from './redaction.mjs';
import { lastRunSummary } from './run-state.mjs';

/** The allow-list. Adding to it is a code change, reviewed like any other. */
export const PACKET_FILES = Object.freeze([
  'docs/CURRENT_STATE.md',
  'docs/NEXT_ACTIONS.md',
  'docs/project-state.json',
  'docs/DECISIONS.md',
  'tools/autopilot/AUTOPILOT_POLICY.md',
]);

const LIMITS = Object.freeze({
  perFile: 28_000,
  contract: 14_000,
  total: 160_000,
  logEntries: 20,
});

const clip = (text, max, label) =>
  text.length > max ? `${text.slice(0, max)}\n\n…[${label} truncated at ${max} chars]…\n` : text;

const readIfPresent = (root, rel, max, fsImpl = fs) => {
  const file = path.join(root, rel);
  if (!fsImpl.existsSync(file)) return null;
  try {
    return clip(fsImpl.readFileSync(file, 'utf8'), max, rel);
  } catch {
    return null;
  }
};

/** Contracts named by the current milestone, plus the names of all the others. */
function contracts(root, fsImpl = fs) {
  const docs = path.join(root, 'docs');
  if (!fsImpl.existsSync(docs)) return { named: [], all: [] };
  const all = fsImpl
    .readdirSync(docs)
    .filter((n) => n.startsWith('CONTRACT_') && n.endsWith('.md'))
    .sort();

  let named = [];
  const stateFile = path.join(docs, 'project-state.json');
  if (fsImpl.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
      const ref = state?.current_milestone?.contract;
      if (typeof ref === 'string') named = [path.basename(ref)];
    } catch {
      named = [];
    }
  }
  // Fall back to the most recently modified contract, which is the one the
  // repository was last working against.
  if (named.length === 0 && all.length > 0) {
    named = [
      all
        .map((n) => ({ n, m: fsImpl.statSync(path.join(docs, n)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0].n,
    ];
  }
  return { named: named.filter((n) => all.includes(n)), all };
}

const packageScripts = (root, fsImpl = fs) => {
  const file = path.join(root, 'package.json');
  if (!fsImpl.existsSync(file)) return {};
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
};

/**
 * @param {object} input
 * @param {string} input.root
 * @param {string} input.ownerGoal
 * @param {string} input.headSha
 * @param {string} input.baseBranch
 * @param {string} input.recentLog
 */
export async function buildProjectPacket({
  root,
  ownerGoal,
  headSha,
  baseBranch,
  recentLog,
  fsImpl = fs,
}) {
  const sections = [];
  const push = (title, body) => {
    if (body && String(body).trim() !== '') sections.push(`## ${title}\n\n${body}`);
  };

  push(
    'Owner goal (outranks every model-generated roadmap idea)',
    ownerGoal,
  );
  push(
    'Repository position',
    [`base branch: ${baseBranch}`, `HEAD: ${headSha}`, '', '```', clip(recentLog, 4000, 'log'), '```'].join('\n'),
  );

  for (const rel of PACKET_FILES) {
    const body = readIfPresent(root, rel, LIMITS.perFile, fsImpl);
    if (body) push(rel, body);
  }

  const { named, all } = contracts(root, fsImpl);
  if (all.length > 0) push('Contracts in this repository', all.map((n) => `- docs/${n}`).join('\n'));
  for (const name of named) {
    const body = readIfPresent(root, `docs/${name}`, LIMITS.contract, fsImpl);
    if (body) push(`Active contract — docs/${name}`, body);
  }

  const scripts = packageScripts(root, fsImpl);
  push('package.json scripts (the controller runs a fixed subset of these as gates)', '```json\n' + JSON.stringify(scripts, null, 2) + '\n```');

  const previous = lastRunSummary({ root, fsImpl });
  if (previous) push('Previous Autopilot run', '```json\n' + JSON.stringify(previous, null, 2) + '\n```');

  const packet = clip(sections.join('\n\n'), LIMITS.total, 'packet');

  // Belt: the allow-list should make this impossible. Braces: it is the last
  // point at which a leak is still cheap to stop.
  return assertNoSecrets(redact(packet));
}

export const __test = { contracts, clip, LIMITS };
