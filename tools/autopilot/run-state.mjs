/**
 * The run record: enough to diagnose or resume an interrupted run, and nothing
 * that should not exist on disk.
 *
 *   .apsis-autopilot/runs/<run-id>/run.json        the spine, rewritten each step
 *   .apsis-autopilot/runs/<run-id>/planner.json    the TaskSpec as validated
 *   .apsis-autopilot/runs/<run-id>/worker-N.txt    worker summary, redacted
 *   .apsis-autopilot/runs/<run-id>/gates-N.json    controller gate results
 *   .apsis-autopilot/runs/<run-id>/review-N.json   reviewer verdict
 *
 * Everything goes through `redactDeep` on the way in. This directory lives
 * INSIDE the repository, so a leaked key here is a key one `git add -A` away
 * from being published — and the next planner packet reads repository files.
 * The `.apsis-autopilot/` entry in .gitignore is the second line of defence,
 * not the first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { redactDeep, redact } from './redaction.mjs';

export const RUNTIME_DIR = '.apsis-autopilot';

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `run-${stamp}`;
}

export function createRunStore({ root, runId = newRunId(), fsImpl = fs } = {}) {
  const dir = path.join(root, RUNTIME_DIR, 'runs', runId);
  fsImpl.mkdirSync(dir, { recursive: true });

  const writeJson = (name, value) => {
    fsImpl.writeFileSync(path.join(dir, name), `${JSON.stringify(redactDeep(value), null, 2)}\n`, 'utf8');
  };
  const writeText = (name, text) => {
    fsImpl.writeFileSync(path.join(dir, name), `${redact(text)}\n`, 'utf8');
  };

  let record = {
    runId,
    version: 1,
    startedAt: new Date().toISOString(),
    status: 'started',
    steps: [],
  };

  const flush = () => writeJson('run.json', record);
  flush();

  return {
    runId,
    dir,
    get record() {
      return record;
    },
    /** Merge top-level fields and persist. */
    update(patch) {
      record = { ...record, ...patch, updatedAt: new Date().toISOString() };
      flush();
      return record;
    },
    /** Append one timeline entry. The timeline is what makes a run diagnosable. */
    step(name, detail = {}) {
      record.steps.push({ at: new Date().toISOString(), name, ...redactDeep(detail) });
      flush();
      return record;
    },
    writeJson,
    writeText,
  };
}

/** Read back a prior run's outcome for the next planner packet (B6). */
export function lastRunSummary({ root, fsImpl = fs, limit = 1 } = {}) {
  const runsDir = path.join(root, RUNTIME_DIR, 'runs');
  if (!fsImpl.existsSync(runsDir)) return null;
  const ids = fsImpl
    .readdirSync(runsDir)
    .filter((name) => name.startsWith('run-'))
    .sort()
    .slice(-limit);
  if (ids.length === 0) return null;

  const summaries = [];
  for (const id of ids) {
    const file = path.join(runsDir, id, 'run.json');
    if (!fsImpl.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      summaries.push({
        runId: parsed.runId,
        status: parsed.status,
        taskId: parsed.taskSpec?.taskId ?? null,
        title: parsed.taskSpec?.title ?? null,
        branch: parsed.branch ?? null,
        verdict: parsed.verdict ?? null,
        failedGates: parsed.failedGates ?? [],
        stoppedBecause: parsed.stoppedBecause ?? null,
      });
    } catch {
      // A corrupt record is not a reason to refuse to plan; it is a reason not
      // to claim knowledge of what happened last time.
      summaries.push({ runId: id, status: 'unreadable' });
    }
  }
  return summaries.length > 0 ? summaries : null;
}
