/**
 * Configuration, and the one rule that governs it: a secret is read, never
 * carried.
 *
 * `loadConfig()` returns `hasApiKey: true|false` and a `readApiKey()` function.
 * The value itself is not a property of the config object, because config
 * objects get logged, serialised into run records, and included in error
 * detail. Making the key unreachable by `JSON.stringify` is cheaper than
 * remembering to strip it everywhere.
 *
 * Note which names are absent: nothing here is VITE_-prefixed, and nothing here
 * is read by Apsis. The browser env contract is untouched — these variables
 * exist only in the shell that runs this CLI.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  openaiModel: 'gpt-6-astra',
  reasoningEffort: 'high',
  claudeModel: 'claude-opus-5',
  claudeBin: 'claude',
  runtimeDir: '.apsis-autopilot',
  maxTasks: 1,
  maxRepairCycles: 3,
  maxPlanningCallsPerTask: 1,
  maxReviewCallsPerIteration: 1,
  /**
   * No default, on purpose (D66). A real run must be given a ceiling by the
   * owner; inventing one would be pretending to know what a task of unknown
   * size costs on their plan. `plan` and `dry-run` never need it.
   */
  workerBudgetUsd: null,
  gateTimeoutMs: 30 * 60_000,
  workerTimeoutMs: 60 * 60_000,
});

const EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * A local, gitignored env file, loaded only if present.
 *
 * Minimal on purpose — `KEY=value`, `#` comments, optional quotes. A full
 * dotenv implementation would be a dependency, and this file's whole job is to
 * avoid adding one.
 */
export function loadEnvFile(file, env = {}) {
  if (!fs.existsSync(file)) return env;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A real environment variable always wins over the file.
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export function loadConfig({ env = process.env, cwd = process.cwd(), repoRoot = null } = {}) {
  const root = repoRoot ?? cwd;
  const merged = { ...env };
  loadEnvFile(path.join(root, '.env.autopilot'), merged);
  loadEnvFile(path.join(root, 'tools', 'autopilot', '.env.local'), merged);

  const effort = merged.OPENAI_AUTOPILOT_REASONING_EFFORT;
  const rawKey = typeof merged.OPENAI_API_KEY === 'string' ? merged.OPENAI_API_KEY.trim() : '';

  const config = {
    openaiModel: merged.OPENAI_AUTOPILOT_MODEL?.trim() || DEFAULTS.openaiModel,
    reasoningEffort: EFFORTS.has(effort) ? effort : DEFAULTS.reasoningEffort,
    claudeModel: merged.APSIS_AUTOPILOT_CLAUDE_MODEL?.trim() || DEFAULTS.claudeModel,
    claudeBin: merged.APSIS_AUTOPILOT_CLAUDE_BIN?.trim() || DEFAULTS.claudeBin,
    runtimeDir: DEFAULTS.runtimeDir,
    maxTasks: positiveInt(merged.APSIS_AUTOPILOT_MAX_TASKS, DEFAULTS.maxTasks),
    maxRepairCycles: clamp(positiveInt(merged.APSIS_AUTOPILOT_MAX_REPAIRS, DEFAULTS.maxRepairCycles), 0, 3),
    workerBudgetUsd: numberOrNull(merged.APSIS_AUTOPILOT_WORKER_BUDGET_USD),
    gateTimeoutMs: DEFAULTS.gateTimeoutMs,
    workerTimeoutMs: DEFAULTS.workerTimeoutMs,

    hasApiKey: rawKey !== '',
    /** Present but never enumerable: the value must not land in a run record. */
    readApiKey: () => rawKey,
  };

  Object.defineProperty(config, 'readApiKey', { enumerable: false, value: config.readApiKey });
  return config;
}

const positiveInt = (raw, fallback) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const numberOrNull = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** What is safe to print or persist. Note the absence of the key itself. */
export const describeConfig = (config) => ({
  openaiModel: config.openaiModel,
  reasoningEffort: config.reasoningEffort,
  claudeModel: config.claudeModel,
  claudeBin: config.claudeBin,
  maxTasks: config.maxTasks,
  maxRepairCycles: config.maxRepairCycles,
  workerBudgetUsd: config.workerBudgetUsd,
  apiKey: config.hasApiKey ? 'present' : 'missing',
});
