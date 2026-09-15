/**
 * Model handoff protocol (§34, §37.3).
 *
 * §37 rule 3: never discard project context during a handoff. The failure mode
 * this guards against is the ordinary one — a handoff that carries the task but
 * not the constraints, so the receiving model cheerfully rewrites something that
 * was deliberate.
 *
 * {@link Handoff} lists every field §34 requires, and `formatHandoff` renders it
 * as text a human can paste into a fresh session. `missingFromHandoff` reports
 * what is absent, so an incomplete handoff can be caught before it is delivered
 * rather than discovered afterwards.
 */

import type { Handoff, ModelId, RoutingDecision } from './types';

export interface HandoffDraft extends Omit<Handoff, 'createdAt' | 'toModel'> {
  readonly toModel: ModelId | null;
}

/** Fields §34 names explicitly. Used to check a draft is actually complete. */
const REQUIRED: ReadonlyArray<keyof Handoff> = [
  'taskDescription',
  'projectPhase',
  'architectureDecisions',
  'filesChanged',
  'filesRemaining',
  'implementationStatus',
  'testResults',
  'acceptanceCriteria',
];

/**
 * Which required fields are empty.
 *
 * Empty arrays count as missing: "no architecture decisions" is almost always
 * an unfilled field rather than a true statement about the work.
 */
export function missingFromHandoff(draft: Partial<Handoff>): Array<keyof Handoff> {
  return REQUIRED.filter((key) => {
    const v = draft[key];
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).trim() === '';
  });
}

export function createHandoff(draft: HandoffDraft, at: number): Handoff | null {
  if (!draft.toModel) return null;
  return { ...draft, toModel: draft.toModel, createdAt: at };
}

const bullets = (items: readonly string[]) =>
  items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none recorded)';

/**
 * Render a handoff as pasteable text.
 *
 * Plain text on purpose: the receiving end may be a fresh session with no access
 * to this application's state, so the handoff has to survive as nothing but
 * characters in a prompt.
 */
export function formatHandoff(h: Handoff): string {
  return [
    `HANDOFF → ${h.toModel.toUpperCase()}`,
    h.fromModel ? `From: ${h.fromModel}` : 'From: (unspecified)',
    `Phase: ${h.projectPhase}`,
    '',
    'TASK',
    h.taskDescription,
    '',
    'ARCHITECTURE DECISIONS — do not revisit without reason',
    bullets(h.architectureDecisions),
    '',
    'FILES CHANGED',
    bullets(h.filesChanged),
    '',
    'FILES REMAINING',
    bullets(h.filesRemaining),
    '',
    `IMPLEMENTATION STATUS`,
    h.implementationStatus,
    '',
    'KNOWN BUGS',
    bullets(h.knownBugs),
    '',
    'TEST RESULTS',
    h.testResults,
    '',
    'VISUAL REQUIREMENTS',
    bullets(h.visualRequirements),
    '',
    'ACCEPTANCE CRITERIA',
    bullets(h.acceptanceCriteria),
    '',
    'UNRESOLVED QUESTIONS',
    bullets(h.unresolvedQuestions),
  ].join('\n');
}

/**
 * The instruction a user needs when the switch cannot be automated.
 *
 * §30: "surface a clear instruction telling the user which model to select for
 * the next phase." §35: "Never hide this distinction from the user."
 */
export function switchInstruction(decision: RoutingDecision): string | null {
  if (!decision.requiresUserSwitch || !decision.selectedModel) return null;
  return `ACTION REQUIRED: switch to ${decision.selectedModel.toUpperCase()} for the ${decision.phase} phase.`;
}
