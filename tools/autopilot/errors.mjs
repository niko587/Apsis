/**
 * One error type, because every failure in this controller has to be
 * *classifiable* rather than merely reported.
 *
 * Autopilot fails closed: a malformed planner answer, a network blip, a worker
 * that dies, a boundary violation — none of them may be papered over into a
 * "probably fine" run that ends by asking the owner to merge. The `code` is what
 * the run record and the exit path key off, so it is never free text.
 */

export const CODES = Object.freeze({
  DIRTY_TREE: 'dirty-tree',
  NOT_A_REPO: 'not-a-repo',
  GIT_FAILED: 'git-failed',
  NO_API_KEY: 'no-api-key',
  OPENAI_HTTP: 'openai-http',
  OPENAI_NETWORK: 'openai-network',
  OPENAI_INCOMPLETE: 'openai-incomplete',
  OPENAI_REFUSAL: 'openai-refusal',
  OPENAI_MALFORMED: 'openai-malformed',
  SCHEMA_INVALID: 'schema-invalid',
  WORKER_FAILED: 'worker-failed',
  WORKER_MALFORMED: 'worker-malformed',
  FORBIDDEN_FILE: 'forbidden-file',
  UNLISTED_FILE: 'unlisted-file',
  UNSAFE_PATH: 'unsafe-path',
  UNKNOWN_GATE: 'unknown-gate',
  GATE_FAILED: 'gate-failed',
  REPAIR_LIMIT: 'repair-limit',
  STALE_BASE: 'stale-base',
  CLAUDE_MISSING: 'claude-missing',
  REFUSED_PUSH: 'refused-push',
});

export class AutopilotError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message human-readable, already redacted by the caller
   * @param {object} [detail] structured extras for the run record
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'AutopilotError';
    this.code = code;
    this.detail = detail;
  }
}

export const fail = (code, message, detail) => {
  throw new AutopilotError(code, message, detail);
};
