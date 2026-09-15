import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_ENVIRONMENT,
  buildRegistry,
  detectCapabilities,
  routingMode,
} from './registry';
import { confirmExecution, logDecision, makeTask, route } from './router';
import { switchInstruction } from './handoff';

const architecture = makeTask({
  id: 't_arch',
  description: 'Design the lead event architecture',
  type: 'architecture',
  complexity: 0.85,
  reasoningComplexity: 0.9,
  integrationComplexity: 0.8,
});

const shaders = makeTask({
  id: 't_shader',
  description: 'Write the GPU particle shader for the lead field',
  type: 'shaders',
  complexity: 0.8,
  visualComplexity: 0.95,
});

describe('capability detection (§37.1 — never fabricate availability)', () => {
  it('reports nothing reachable when the environment declares nothing', () => {
    expect(detectCapabilities(undefined)).toEqual(UNKNOWN_ENVIRONMENT);
    expect(detectCapabilities({})).toEqual(UNKNOWN_ENVIRONMENT);
  });

  it('marks every model unavailable in an undeclared environment', () => {
    const reg = buildRegistry(UNKNOWN_ENVIRONMENT);
    expect(reg.length).toBeGreaterThan(0);
    for (const m of reg) expect(m.invocation).toBe('unavailable');
  });

  it('ignores declared models it has no profile for', () => {
    const env = detectCapabilities({
      __APSIS_MODEL_ENV__: {
        activeModel: 'opus',
        programmaticModels: ['definitely-not-a-model'],
      },
    });
    expect(env.programmaticModels).toEqual([]);
    expect(env.activeModel).toBe('opus');
  });

  it('treats the active model as interactive, not programmatic', () => {
    // The distinction §30 turns on: selectable by a human is not invocable by us.
    const reg = buildRegistry({ activeModel: 'opus', selectableModels: [], programmaticModels: [] });
    expect(reg.find((m) => m.id === 'opus')!.invocation).toBe('interactive');
    expect(routingMode(reg)).toBe('assisted');
  });

  it('only reports automated mode when something is genuinely invocable', () => {
    expect(
      routingMode(buildRegistry({ activeModel: 'opus', selectableModels: [], programmaticModels: [] })),
    ).toBe('assisted');
    expect(
      routingMode(
        buildRegistry({ activeModel: 'opus', selectableModels: [], programmaticModels: ['fable'] }),
      ),
    ).toBe('automated');
  });
});

describe('routing policy (§32)', () => {
  const reg = buildRegistry({
    activeModel: 'opus',
    selectableModels: [],
    programmaticModels: ['opus', 'fable', 'sonnet'],
  });

  it('sends architecture to Opus and shaders to Fable', () => {
    expect(route(architecture, reg).selectedModel).toBe('opus');
    expect(route(shaders, reg).selectedModel).toBe('fable');
  });

  it('is deterministic — no routing for novelty (§37.4)', () => {
    const a = route(architecture, reg);
    const b = route(architecture, reg);
    expect(a.selectedModel).toBe(b.selectedModel);
    expect(a.confidence).toBe(b.confidence);
  });

  it('always offers a fallback when one exists (§36)', () => {
    expect(route(shaders, reg).fallbackModel).not.toBeNull();
  });
});

describe('reachability is separate from preference', () => {
  it('still names the better model when it cannot be reached', () => {
    // Fable is best for shaders but only Opus is selectable.
    const reg = buildRegistry({ activeModel: 'opus', selectableModels: [], programmaticModels: [] });
    const d = route(shaders, reg, { activeModel: 'opus' });
    expect(d.selectedModel).toBe('opus');
    expect(d.reason).toContain('Fable');
    expect(d.reason).toMatch(/not reachable/i);
  });

  it('flags requiresUserSwitch only when the target is NOT already active (§30)', () => {
    // Fable is selectable but the user is on Opus: a real switch is required.
    const reg = buildRegistry({
      activeModel: 'opus',
      selectableModels: ['fable'],
      programmaticModels: [],
    });
    expect(route(shaders, reg, { activeModel: 'opus' }).requiresUserSwitch).toBe(true);
  });

  it('does not demand a switch to the model already selected', () => {
    // The bug this guards: emitting "ACTION REQUIRED: switch to OPUS" while Opus
    // is the active model. Collapsing "on it" and "could move to it" caused it.
    const reg = buildRegistry({ activeModel: 'opus', selectableModels: [], programmaticModels: [] });
    const d = route(shaders, reg, { activeModel: 'opus' });
    expect(d.selectedModel).toBe('opus');
    expect(d.requiresUserSwitch).toBe(false);
    expect(switchInstruction(d)).toBeNull();
  });

  it('does not flag a switch when the model is programmatically invocable', () => {
    const reg = buildRegistry({ activeModel: 'opus', selectableModels: [], programmaticModels: ['fable'] });
    const d = route(shaders, reg, { activeModel: 'opus' });
    expect(d.selectedModel).toBe('fable');
    expect(d.requiresUserSwitch).toBe(false);
  });

  it('blocks rather than silently downgrading when nothing is reachable (§36)', () => {
    const d = route(shaders, buildRegistry(UNKNOWN_ENVIRONMENT));
    expect(d.selectedModel).toBeNull();
    expect(d.blocked).toBeTruthy();
    // It must not quietly present some other model as equivalent.
    expect(d.confidence).toBe(0);
  });
});

describe('routing log (§37.2, §37.10)', () => {
  const reg = buildRegistry({ activeModel: 'opus', selectableModels: [], programmaticModels: ['opus'] });

  it('records a decision as pending, never as used', () => {
    const log = logDecision([], route(architecture, reg), reg, 1);
    expect(log[0].execution).toBe('pending');
  });

  it('only marks execution confirmed when something confirms it', () => {
    let log = logDecision([], route(architecture, reg), reg, 1);
    log = confirmExecution(log, 't_arch', 'confirmed');
    expect(log[0].execution).toBe('confirmed');
  });

  it('can record that routed work was declined', () => {
    let log = logDecision([], route(architecture, reg), reg, 1);
    log = confirmExecution(log, 't_arch', 'declined');
    expect(log[0].execution).toBe('declined');
  });

  it('never rewrites an already-settled entry', () => {
    let log = logDecision([], route(architecture, reg), reg, 1);
    log = confirmExecution(log, 't_arch', 'confirmed');
    log = confirmExecution(log, 't_arch', 'declined');
    expect(log[0].execution).toBe('confirmed');
  });
});
