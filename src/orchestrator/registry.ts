/**
 * Model registry and capability detection (§32, §37).
 *
 * This is the file where a Model Orchestrator usually starts lying.
 *
 * The tempting implementation hardcodes a list of models from documentation and
 * reports them as available. §37 rule 1 forbids exactly that, and §32 says it
 * outright: "Do not assume a model exists merely because it appears in
 * documentation or in this prompt. The router must inspect actual available
 * capabilities/configuration."
 *
 * So the profiles below describe what each model is GOOD AT — a static, honest
 * claim about suitability. They say nothing about whether it can be reached.
 * Reachability comes from a descriptor the environment supplies, and in the
 * absence of one, every model is `unavailable` except the one the user tells us
 * is currently selected, which is `interactive` — present, but only switchable
 * by hand.
 *
 * A browser bundle genuinely cannot discover which models an account may invoke.
 * Admitting that is the correct behaviour, not a limitation to paper over.
 */

import type { Invocation, ModelId, ModelProfile, RoutingMode, TaskType } from './types';

/** Task types that reward deep reasoning and system-level context. */
const REASONING_TASKS: readonly TaskType[] = [
  'architecture',
  'state_management',
  'data_modelling',
  'api_integration',
  'agent_orchestration',
  'business_logic',
  'debugging',
  'refactoring',
  'performance',
  'verification',
];

/** Task types that reward visual and spatial craft. */
const VISUAL_TASKS: readonly TaskType[] = [
  'three_d',
  'shaders',
  'procedural_geometry',
  'particles',
  'animation',
  'visual_composition',
  'interaction_polish',
];

/**
 * Suitability profiles only — see the header. Nothing here asserts availability.
 * Ordering is not precedence; the router scores these.
 */
const PROFILES: ReadonlyArray<Omit<ModelProfile, 'invocation'>> = [
  {
    id: 'opus',
    label: 'Opus',
    strengths: REASONING_TASKS,
    weaknesses: ['shaders', 'procedural_geometry'],
    costProfile: 'high',
    latencyProfile: 'medium',
    contextProfile: 200_000,
  },
  {
    id: 'fable',
    label: 'Fable',
    strengths: VISUAL_TASKS,
    weaknesses: ['data_modelling', 'api_integration'],
    costProfile: 'high',
    latencyProfile: 'medium',
    contextProfile: 200_000,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    // §32: "Only use when the current environment exposes them and the task is
    // appropriately scoped." Deliberately narrow — it is not a general fallback.
    strengths: ['refactoring', 'verification', 'business_logic'],
    weaknesses: ['architecture', 'shaders', 'agent_orchestration'],
    costProfile: 'medium',
    latencyProfile: 'fast',
    contextProfile: 200_000,
  },
];

/**
 * What the environment actually tells us about model reachability.
 *
 * Supplied by configuration, never inferred. `programmaticModels` should be
 * populated only where a real invocation mechanism exists (an SDK call, a
 * subprocess, an agent framework) — not because a model is known to exist.
 */
export interface EnvironmentCapabilities {
  /** The model the user currently has selected, if the environment reports it. */
  readonly activeModel: ModelId | null;
  /**
   * Models the user could switch to by hand.
   *
   * Distinct from `activeModel` on purpose. Collapsing the two made the panel
   * emit "ACTION REQUIRED: switch to OPUS" while Opus was already selected —
   * §30's distinction is between the model you are ON and the models you could
   * MOVE TO, and a router that cannot tell them apart cannot say anything useful
   * about switching.
   */
  readonly selectableModels: readonly ModelId[];
  /** Models this build can actually invoke without human action. */
  readonly programmaticModels: readonly ModelId[];
}

/** The honest default: nothing is reachable and we say so. */
export const UNKNOWN_ENVIRONMENT: EnvironmentCapabilities = {
  activeModel: null,
  selectableModels: [],
  programmaticModels: [],
};

/**
 * Read capabilities the host page has explicitly declared.
 *
 * Returns the unknown-environment default when nothing is declared, rather than
 * guessing. An orchestrator that assumes reachability will eventually report a
 * handoff that never happened.
 */
export function detectCapabilities(
  globalScope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis,
): EnvironmentCapabilities {
  const declared = (globalScope as { __APSIS_MODEL_ENV__?: unknown } | undefined)
    ?.__APSIS_MODEL_ENV__;
  if (!declared || typeof declared !== 'object') return UNKNOWN_ENVIRONMENT;

  const d = declared as Partial<EnvironmentCapabilities>;
  const known = new Set(PROFILES.map((p) => p.id));
  // Filtered against the registry: a descriptor naming a model we have no
  // profile for cannot be routed to, so accepting it would be meaningless.
  const filter = (v: unknown): ModelId[] =>
    Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string' && known.has(m)) : [];

  const activeModel =
    typeof d.activeModel === 'string' && known.has(d.activeModel) ? d.activeModel : null;
  const selectable = new Set(filter(d.selectableModels));
  // The active model is selectable by definition — it is already selected.
  if (activeModel) selectable.add(activeModel);

  return {
    activeModel,
    selectableModels: [...selectable],
    programmaticModels: filter(d.programmaticModels),
  };
}

function invocationFor(id: ModelId, env: EnvironmentCapabilities): Invocation {
  if (env.programmaticModels.includes(id)) return 'programmatic';
  // The active model is selectable by definition — it is already selected.
  //
  // This belongs here rather than in `detectCapabilities`, which is only one of
  // the ways capabilities get built. Enforcing it during parsing left every
  // caller that constructed an `EnvironmentCapabilities` directly with a
  // registry that marked the model currently in use as `unavailable`.
  if (env.activeModel === id || env.selectableModels.includes(id)) return 'interactive';
  return 'unavailable';
}

/** The registry, resolved against a specific environment. */
export function buildRegistry(env: EnvironmentCapabilities): ModelProfile[] {
  return PROFILES.map((p) => ({ ...p, invocation: invocationFor(p.id, env) }));
}

/**
 * §35: the mode shown to the user.
 *
 * `automated` only when something can genuinely be invoked without the human.
 * Anything else is `assisted`, and the UI must say so.
 */
export function routingMode(registry: readonly ModelProfile[]): RoutingMode {
  return registry.some((m) => m.invocation === 'programmatic') ? 'automated' : 'assisted';
}

export { PROFILES as MODEL_PROFILES, REASONING_TASKS, VISUAL_TASKS };
