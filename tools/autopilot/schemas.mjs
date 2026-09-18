/**
 * The two contracts GPT is allowed to speak in.
 *
 * Everything the planner and reviewer produce arrives through one of these.
 * Note what is NOT in either: a command, a path outside the repository, a gate
 * the controller does not own, a merge instruction. The model cannot ask for
 * those, because there is no field in which to ask.
 *
 * `strict: true` on the provider side and `validate()` on this side are doing
 * the same job twice on purpose — see validate.mjs.
 */

import { GATE_NAMES } from './gates.mjs';
import { validate, forModel } from './validate.mjs';
import { CODES, fail } from './errors.mjs';

export const WORKER_MODELS = Object.freeze(['claude-opus-5', 'claude-fable-5']);
export const RISKS = Object.freeze(['low', 'medium', 'high']);
export const VERDICTS = Object.freeze(['accept', 'repair', 'escalate']);
export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

/** Hard ceiling. A TaskSpec may ask for fewer repairs, never more (B13). */
export const MAX_REPAIR_CYCLES = 3;

export const TASK_SPEC_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'taskId',
    'title',
    'goal',
    'reason',
    'workerModel',
    'risk',
    'allowedFiles',
    'forbiddenFiles',
    'protectedInvariants',
    'requiredGates',
    'acceptanceCriteria',
    'maxRepairCycles',
  ],
  properties: {
    taskId: {
      type: 'string',
      description: 'Short slug, lowercase letters, digits and hyphens only.',
      minLength: 3,
      maxLength: 64,
      pattern: '^[a-z0-9][a-z0-9-]*$',
    },
    title: { type: 'string', description: 'One line.', minLength: 3, maxLength: 120 },
    goal: {
      type: 'string',
      description: 'What the worker must achieve, stated so a reviewer can check it.',
      minLength: 20,
      maxLength: 4000,
    },
    reason: {
      type: 'string',
      description: 'Why this task, now, given the owner goal and project state.',
      minLength: 10,
      maxLength: 2000,
    },
    workerModel: { type: 'string', enum: [...WORKER_MODELS] },
    risk: { type: 'string', enum: [...RISKS] },
    allowedFiles: {
      type: 'array',
      description:
        'Repo-relative path globs the worker may create or modify. Must be non-empty and must not escape the repository.',
      items: { type: 'string', minLength: 1, maxLength: 256 },
      minItems: 1,
      maxItems: 60,
    },
    forbiddenFiles: {
      type: 'array',
      description: 'Repo-relative path globs the worker must not touch.',
      items: { type: 'string', minLength: 1, maxLength: 256 },
      maxItems: 60,
    },
    protectedInvariants: {
      type: 'array',
      description: 'Properties of the repository this task must not break.',
      items: { type: 'string', minLength: 3, maxLength: 500 },
      maxItems: 30,
    },
    requiredGates: {
      type: 'array',
      description: 'Names of controller-owned gates. Not commands.',
      items: { type: 'string', enum: [...GATE_NAMES] },
      minItems: 1,
      maxItems: GATE_NAMES.length,
    },
    acceptanceCriteria: {
      type: 'array',
      description: 'Checkable statements. The reviewer is held to these.',
      items: { type: 'string', minLength: 5, maxLength: 500 },
      minItems: 1,
      maxItems: 20,
    },
    maxRepairCycles: { type: 'integer', minimum: 0, maximum: MAX_REPAIR_CYCLES },
  },
});

export const REVIEW_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'repairPrompt', 'ownerAttention'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'issue', 'requiredFix'],
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          file: { type: 'string', maxLength: 256 },
          issue: { type: 'string', minLength: 1, maxLength: 2000 },
          requiredFix: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
      maxItems: 40,
    },
    repairPrompt: {
      type: 'string',
      description: 'Empty string when the verdict is not "repair".',
      maxLength: 8000,
    },
    ownerAttention: {
      type: 'string',
      description: 'Empty string when nothing needs the owner.',
      maxLength: 2000,
    },
  },
});

/** What actually goes on the wire — the local-only keywords stripped. */
export const TASK_SPEC_SCHEMA_FOR_MODEL = forModel(TASK_SPEC_SCHEMA);
export const REVIEW_RESULT_SCHEMA_FOR_MODEL = forModel(REVIEW_RESULT_SCHEMA);

const checked = (value, schema, label, code = CODES.SCHEMA_INVALID) => {
  const { ok, errors } = validate(value, schema);
  if (!ok) fail(code, `${label} failed validation: ${errors.slice(0, 8).join('; ')}`, { errors });
  return value;
};

/**
 * Validate a TaskSpec, then apply the checks a JSON Schema cannot express.
 *
 * The clamp on `maxRepairCycles` is not a courtesy to the model. A spec asking
 * for 9 repair cycles is a spec asking the controller to spend nine times the
 * budget on one task, and the ceiling belongs to the controller (B13).
 */
export function parseTaskSpec(value) {
  checked(value, TASK_SPEC_SCHEMA, 'TaskSpec');

  const gates = value.requiredGates;
  if (new Set(gates).size !== gates.length) {
    fail(CODES.SCHEMA_INVALID, 'TaskSpec repeats a gate');
  }
  // Belt and braces with the enum above: the gate table is the authority, and
  // this is the check that survives someone editing the schema.
  for (const gate of gates) {
    if (!GATE_NAMES.includes(gate)) {
      fail(CODES.UNKNOWN_GATE, `TaskSpec names a gate the controller does not own: ${String(gate).slice(0, 60)}`);
    }
  }

  return Object.freeze({
    ...value,
    maxRepairCycles: Math.min(value.maxRepairCycles, MAX_REPAIR_CYCLES),
  });
}

export function parseReviewResult(value) {
  checked(value, REVIEW_RESULT_SCHEMA, 'ReviewResult');
  if (value.verdict === 'repair' && value.repairPrompt.trim() === '') {
    fail(CODES.SCHEMA_INVALID, 'ReviewResult asks for repair without saying what to repair');
  }
  return Object.freeze(value);
}
