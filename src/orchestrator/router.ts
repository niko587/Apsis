/**
 * The routing engine (§31, §32, §36, §37).
 *
 * Scores every model in the registry against a task and picks the best one that
 * can actually be reached. Two rules shape the whole design:
 *
 *   §37.5  Route on task requirements, not novelty.
 *   §37.4  Never switch models merely for variety.
 *
 * So routing is a pure function of the task and the registry. Nothing here is
 * stateful, random, or time-dependent — the same task always routes the same
 * way, which is what makes the decision auditable after the fact.
 */

import type {
  ModelProfile,
  RoutingDecision,
  RoutingLogEntry,
  RoutingMode,
  Task,
  TaskType,
} from './types';
import { routingMode } from './registry';

/** Suitability of one model for one task, 0-1. */
export function score(model: ModelProfile, task: Task): number {
  let s = 0.5;

  if (model.strengths.includes(task.type)) s += 0.32;
  if (model.weaknesses.includes(task.type)) s -= 0.34;

  // Dimension weighting. A task can be visual AND integration-heavy; the
  // dominant axis should decide, not whichever flag was checked first.
  const visualPull = task.visualComplexity - task.reasoningComplexity;
  const isVisualModel = model.strengths.some((t) => VISUAL.has(t));
  s += (isVisualModel ? visualPull : -visualPull) * 0.18;

  // Integration risk wants the strongest reasoning available (§37.7).
  if (task.integrationComplexity > 0.6 && model.strengths.includes('api_integration')) {
    s += 0.12;
  }

  // §37.6: prefer the smallest capable model. Only for genuinely easy work —
  // applying it broadly would quietly downgrade hard tasks, which §36 forbids.
  const easy =
    task.complexity < 0.35 &&
    task.integrationComplexity < 0.35 &&
    task.visualComplexity < 0.35;
  if (easy && model.costProfile === 'medium') s += 0.14;

  if (task.contextRequirements > model.contextProfile) s -= 0.4;

  return Math.max(0, Math.min(1, s));
}

const VISUAL = new Set<TaskType>([
  'three_d',
  'shaders',
  'procedural_geometry',
  'particles',
  'animation',
  'visual_composition',
  'interaction_polish',
]);

export interface RouteOptions {
  /** Phase label carried into the decision, for telemetry and handoff. */
  phase?: string;
  /**
   * The model currently selected. Without it, any interactive model looks like
   * it needs switching to — including the one already in use.
   */
  activeModel?: string | null;
}

/**
 * Choose a model for a task.
 *
 * Reachability is applied AFTER scoring, not before, so the decision can report
 * the genuinely best model and separately report that the user has to select it.
 * Filtering unreachable models out first would silently present the fallback as
 * the preferred choice — §37.12's "keep the routing layer provider-agnostic"
 * only works if the preference is visible independently of the plumbing.
 */
export function route(
  task: Task,
  registry: readonly ModelProfile[],
  opts: RouteOptions = {},
): RoutingDecision {
  const phase = opts.phase ?? task.currentProjectPhase;

  const ranked = registry
    .map((m) => ({ model: m, s: score(m, task) }))
    .sort((a, b) => b.s - a.s);

  const base: Omit<RoutingDecision, 'selectedModel' | 'reason' | 'confidence'
    | 'fallbackModel' | 'requiresUserSwitch' | 'blocked'> = {
    task,
    phase,
    estimatedComplexity: task.complexity,
  };

  if (ranked.length === 0) {
    return {
      ...base,
      selectedModel: null,
      reason: 'No models are registered.',
      confidence: 0,
      fallbackModel: null,
      requiresUserSwitch: false,
      blocked: 'No models registered.',
    };
  }

  const preferred = ranked[0];
  const usable = ranked.filter((r) => r.model.invocation !== 'unavailable');

  // §36: no suitable model available at all — stop, explain, preserve work.
  // Do NOT silently downgrade and pretend equivalent capability.
  if (usable.length === 0) {
    return {
      ...base,
      selectedModel: null,
      reason: `${preferred.model.label} is the best fit for ${task.type}, but no registered model is reachable in this environment.`,
      confidence: 0,
      fallbackModel: null,
      requiresUserSwitch: false,
      blocked:
        'No model is reachable. Work is preserved and nothing has been executed. Select a model to continue.',
    };
  }

  const chosen = usable[0];
  const runnerUp = usable[1];
  // Confidence is the margin over the runner-up, not the raw score: a model that
  // scores 0.9 when the alternative scores 0.88 is not a confident choice.
  const margin = runnerUp ? chosen.s - runnerUp.s : chosen.s;
  const confidence = Math.max(0, Math.min(1, margin * 2));

  const reason =
    chosen.model.id === preferred.model.id
      ? `${chosen.model.label} is strongest for ${task.type.replace(/_/g, ' ')} at this complexity.`
      : `${preferred.model.label} would be the better fit for ${task.type.replace(/_/g, ' ')}, but it is not reachable here; ${chosen.model.label} is the best available.`;

  return {
    ...base,
    selectedModel: chosen.model.id,
    reason,
    confidence,
    fallbackModel: runnerUp?.model.id ?? null,
    // The honest flag: a human must act ONLY when the chosen model cannot be
    // invoked programmatically AND is not the one already selected. §30 is
    // explicit that an automated switch must never be claimed; it is equally
    // wrong to demand a switch that has already happened.
    requiresUserSwitch:
      chosen.model.invocation === 'interactive' && chosen.model.id !== opts.activeModel,
    blocked: null,
  };
}

/**
 * The routing log (§37.10).
 *
 * `execution` starts at `'pending'` and is only ever advanced by
 * {@link confirmExecution}, which a caller invokes after work has actually run.
 * Nothing sets it from the decision itself — that is how §37.2 ("never claim a
 * model was used unless it actually was") is enforced structurally rather than
 * by discipline.
 */
export function logDecision(
  log: readonly RoutingLogEntry[],
  decision: RoutingDecision,
  registry: readonly ModelProfile[],
  at: number,
): RoutingLogEntry[] {
  const entry: RoutingLogEntry = {
    at,
    decision,
    mode: routingMode(registry),
    execution: 'pending',
  };
  return [entry, ...log].slice(0, 50);
}

export function confirmExecution(
  log: readonly RoutingLogEntry[],
  taskId: string,
  outcome: 'confirmed' | 'declined',
): RoutingLogEntry[] {
  return log.map((e) =>
    e.decision.task.id === taskId && e.execution === 'pending'
      ? { ...e, execution: outcome }
      : e,
  );
}

/** Convenience for the common case of describing a task inline. */
export function makeTask(partial: Partial<Task> & Pick<Task, 'id' | 'description' | 'type'>): Task {
  return {
    complexity: 0.5,
    visualComplexity: 0,
    reasoningComplexity: 0,
    codingComplexity: 0.5,
    integrationComplexity: 0,
    contextRequirements: 30_000,
    currentProjectPhase: 'unspecified',
    dependencies: [],
    priority: 'normal',
    ...partial,
  };
}

export type { RoutingMode };
