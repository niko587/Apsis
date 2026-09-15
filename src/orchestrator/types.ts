/**
 * Model Orchestrator types (master prompt §31).
 *
 * The orchestrator decides which model should perform a unit of work, and — when
 * it cannot perform the switch itself — says so plainly instead of pretending.
 * That distinction is the entire point of §30, and every type here exists to
 * keep it representable rather than glossed.
 */

/** What kind of work a task is. Drives routing far more than its size does. */
export type TaskType =
  | 'architecture'
  | 'state_management'
  | 'data_modelling'
  | 'api_integration'
  | 'agent_orchestration'
  | 'business_logic'
  | 'debugging'
  | 'refactoring'
  | 'performance'
  | 'verification'
  | 'three_d'
  | 'shaders'
  | 'procedural_geometry'
  | 'particles'
  | 'animation'
  | 'visual_composition'
  | 'interaction_polish';

export interface Task {
  readonly id: string;
  readonly description: string;
  readonly type: TaskType;
  /** 0-1. Overall difficulty. */
  readonly complexity: number;
  readonly visualComplexity: number;
  readonly reasoningComplexity: number;
  readonly codingComplexity: number;
  readonly integrationComplexity: number;
  /** Rough context the task needs, in tokens. */
  readonly contextRequirements: number;
  readonly currentProjectPhase: string;
  readonly dependencies: readonly string[];
  readonly priority: 'low' | 'normal' | 'high';
}

export type ModelId = string;

/**
 * How a model can be reached.
 *
 * `interactive` is the case §30 is emphatic about: the model exists, but only the
 * human can select it. A router that treats this as "available" and reports a
 * switch has lied.
 */
export type Invocation = 'programmatic' | 'interactive' | 'unavailable';

export interface ModelProfile {
  readonly id: ModelId;
  readonly label: string;
  /** Task types this model is strongest at. */
  readonly strengths: readonly TaskType[];
  readonly weaknesses: readonly TaskType[];
  readonly costProfile: 'low' | 'medium' | 'high';
  readonly latencyProfile: 'fast' | 'medium' | 'slow';
  readonly contextProfile: number;
  /**
   * How this model can actually be invoked IN THIS ENVIRONMENT.
   *
   * Never hardcoded from documentation. §37 rule 1: never fabricate model
   * availability. This is populated by probing the environment; absent evidence,
   * it is `unavailable`.
   */
  readonly invocation: Invocation;
}

export interface RoutingDecision {
  readonly task: Task;
  readonly selectedModel: ModelId | null;
  readonly reason: string;
  /** 0-1. How strongly the policy prefers this model over the runner-up. */
  readonly confidence: number;
  readonly fallbackModel: ModelId | null;
  /**
   * True when the selected model cannot be invoked programmatically and the user
   * must switch by hand. The UI must never hide this (§35).
   */
  readonly requiresUserSwitch: boolean;
  readonly phase: string;
  readonly estimatedComplexity: number;
  /** Present when no model could be selected at all. */
  readonly blocked: string | null;
}

/** §30: the two honest modes. There is no third. */
export type RoutingMode = 'automated' | 'assisted';

/**
 * Everything that must survive a model handoff (§34).
 *
 * §37 rule 3: never discard project context during a handoff. Making this a
 * concrete record rather than a convention means an incomplete handoff is a type
 * error rather than a thing someone forgot.
 */
export interface Handoff {
  readonly fromModel: ModelId | null;
  readonly toModel: ModelId;
  readonly taskDescription: string;
  readonly projectPhase: string;
  readonly architectureDecisions: readonly string[];
  readonly filesChanged: readonly string[];
  readonly filesRemaining: readonly string[];
  readonly implementationStatus: string;
  readonly knownBugs: readonly string[];
  readonly testResults: string;
  readonly visualRequirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly createdAt: number;
}

/** An entry in the routing log. §37 rule 10: log routing decisions. */
export interface RoutingLogEntry {
  readonly at: number;
  readonly decision: RoutingDecision;
  readonly mode: RoutingMode;
  /**
   * Whether the work actually ran on the selected model.
   *
   * §37 rule 2: never claim a model was used unless it was. This stays
   * `'pending'` until something confirms execution — it is never optimistically
   * set from the routing decision itself.
   */
  readonly execution: 'pending' | 'confirmed' | 'declined';
}
