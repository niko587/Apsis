/**
 * Lead event source — the adapter boundary.
 *
 * THIS IS THE ONLY SIMULATED PART OF APSIS, and it is quarantined here on
 * purpose. It stands in for the thing a production deployment plugs in: a CRM
 * webhook feed, a WebSocket from the dialer, an SSE stream off the agent runner.
 *
 * Read §27 rule 3 carefully — "do not simulate lead movement with arbitrary
 * timers". Nothing here moves a lead. This emits `LeadEvent`s and stops. The
 * scoring engine decides what each event is worth, the store recomputes score,
 * and the Universe reads the new score. Swap this file for a real socket and the
 * rest of the application cannot tell the difference, because the interface it
 * depends on is `LeadEvent`, not this implementation.
 */

import type { AgentTask, LeadEvent, LeadEventKind, Stage } from '../domain/types';
import { rng } from '../domain/seed';
import { agentFor, isAgentDriven, taskDuration } from '../domain/agents';
import { useApsis } from './store';

export interface LeadSource {
  start(): void;
  stop(): void;
}

/**
 * What can plausibly happen next to a lead in a given stage, with weights.
 *
 * Stage-aware rather than uniform: a cold lead gets contacted, an engaged one
 * replies or objects, only an appointment-ready one books. Uniform sampling
 * would produce a shimmering fog with no narrative — you could not watch one
 * lead work its way in.
 */
const TRANSITIONS: Readonly<Record<Stage, ReadonlyArray<[LeadEventKind, number]>>> = {
  cold: [
    ['contacted', 62],
    ['opened', 20],
    ['call_no_answer', 16],
    ['unsubscribed', 2],
  ],
  contacted: [
    ['opened', 30],
    ['clicked', 20],
    ['replied', 22],
    ['call_no_answer', 18],
    ['went_cold', 10],
  ],
  engaged: [
    ['replied', 30],
    ['call_connected', 26],
    ['clicked', 16],
    ['objection', 16],
    ['went_cold', 12],
  ],
  qualified: [
    ['call_connected', 30],
    ['qualified', 28],
    ['appointment_offered', 22],
    ['objection', 14],
    ['went_cold', 6],
  ],
  hot: [
    ['appointment_offered', 40],
    ['qualified', 24],
    ['call_connected', 20],
    ['objection', 16],
  ],
  appointment_ready: [
    ['appointment_booked', 58],
    ['appointment_offered', 24],
    ['objection', 12],
    ['went_cold', 6],
  ],
  // A booked lead is settled. Only a cancellation disturbs it, and rarely.
  booked: [['appointment_cancelled', 100]],
};

function pick(rows: ReadonlyArray<[LeadEventKind, number]>, u: number): LeadEventKind {
  const total = rows.reduce((n, [, w]) => n + w, 0);
  let x = u * total;
  for (const [kind, w] of rows) {
    x -= w;
    if (x <= 0) return kind;
  }
  return rows[rows.length - 1][0];
}

/**
 * Booked leads are excluded from routine selection, otherwise the steady state is
 * a slow drain of the appointment centre back out into the field — the pipeline
 * would run backwards on a long enough session.
 */
const CANCELLATION_RATE = 0.004;

export interface SimulatedSourceOptions {
  /** Events per second across the whole book. */
  eventsPerSecond?: number;
  seed?: number;
}

export function createSimulatedSource(opts: SimulatedSourceOptions = {}): LeadSource {
  const { eventsPerSecond = 9, seed = 0x1a2b3c } = opts;
  const rand = rng(seed);
  let timer: number | null = null;
  let runner: number | null = null;
  let decayTimer: number | null = null;
  let seq = 0;

  const emitOne = () => {
    const state = useApsis.getState();
    const { order, leads } = state;
    if (order.length === 0) return;

    const id = order[Math.floor(rand() * order.length)];
    if (state.claimed.has(id)) return;
    const lead = leads.get(id);
    if (!lead) return;
    if (lead.stage === 'booked' && rand() > CANCELLATION_RATE) return;

    const kind = pick(TRANSITIONS[lead.stage], rand());

    // Inbound: the lead did this. Nothing was occupied, so it lands immediately.
    if (!isAgentDriven(kind)) {
      const event: LeadEvent = {
        id: `evt_${(seq++).toString(36)}`,
        leadId: id,
        kind,
        at: Date.now(),
        agentId: null,
      };
      state.ingest(event);
      return;
    }

    // Outbound: an agent has to actually do this. Open a task, hold the lead,
    // and let it resolve into the event when the work finishes.
    const startedAt = Date.now();
    const task: AgentTask = {
      id: `task_${(seq++).toString(36)}`,
      agentId: agentFor(kind, lead)!,
      leadId: id,
      startedAt,
      dueAt: startedAt + taskDuration(kind, rand()),
      emits: kind,
    };
    state.startTask(task);
  };

  /**
   * Task runner.
   *
   * Stands in for whatever actually performs the work — an LLM call, a dialer
   * API, a send queue. It only decides WHEN a task is done; what that means for
   * the lead is the scoring engine's business, not this file's.
   */
  const drainDueTasks = () => {
    const now = Date.now();
    const state = useApsis.getState();
    for (const task of [...state.tasks.values()]) {
      if (task.dueAt > now) continue;
      state.completeTask(task.id);
    }
  };

  return {
    start() {
      if (timer !== null) return;
      const interval = Math.max(16, 1000 / eventsPerSecond);
      timer = window.setInterval(emitOne, interval);
      // 100ms is a resolution choice, not an animation rate: it bounds how late
      // a task can resolve past its due time. Nothing is drawn from this tick.
      runner = window.setInterval(drainDueTasks, 100);
      // Decay runs on a slow cadence because it is a property of elapsed time,
      // not of the frame rate. Once a minute is plenty for a 72h grace period.
      decayTimer = window.setInterval(() => {
        useApsis.getState().applyDecay(Date.now());
      }, 60_000);
    },
    stop() {
      if (timer !== null) window.clearInterval(timer);
      if (runner !== null) window.clearInterval(runner);
      if (decayTimer !== null) window.clearInterval(decayTimer);
      timer = null;
      runner = null;
      decayTimer = null;
      // Pausing the feed abandons in-flight work rather than leaving orphan
      // tasks holding leads that nothing will ever release.
      useApsis.getState().cancelAllTasks();
    },
  };
}
