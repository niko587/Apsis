/**
 * The single application store.
 *
 * Every visible thing in Apsis — the Universe, the telemetry rail, the agent
 * list, the appointment center — reads from here. The 3D layer has no state of
 * its own, so it cannot disagree with the numbers on screen (§27 rule 4).
 *
 * The ONLY way a lead changes is `ingest(event)`. There is deliberately no
 * `setScore`, no `moveLead`, no direct mutator: if something wants a lead to
 * move it must say why, in the event vocabulary, and the scoring engine decides
 * what that is worth.
 */

import { create } from 'zustand';
import type { Agent, AgentTask, Lead, LeadEvent, LeadEventKind, Stage } from '../domain/types';
import { STAGE_ORDER } from '../domain/types';
import { applyEvent, decayedScore, stageFor } from '../domain/scoring';
import { seedAgents, seedLeads } from '../domain/seed';
import { agentFor, taskDuration } from '../domain/agents';
import { scheduleAppointment, withElapsedStatus, type Appointment } from '../domain/appointments';

export interface Telemetry {
  total: number;
  byStage: Record<Stage, number>;
  booked: number;
  /** Events ingested in the last 60s, for the throughput readout. */
  eventRate: number;
}

interface ApsisState {
  leads: Map<string, Lead>;
  /** Stable draw order. Index into this is the instance index in the Universe. */
  order: string[];
  /**
   * leadId → index in `order`.
   *
   * Exists because the render loop needs that lookup every frame for the
   * selection marker and every in-flight agent arc. `order.indexOf()` is O(n),
   * so at 60,000 leads a handful of arcs turned into hundreds of thousands of
   * comparisons per frame — invisible at the default book size and ruinous past it.
   */
  indexOf: Map<string, number>;
  agents: Agent[];
  /** In-flight agent work, keyed by task id. Completed tasks are removed. */
  tasks: Map<string, AgentTask>;
  /**
   * Leads currently held by an in-flight task — two agents must not work the
   * same person at once.
   *
   * Lives in the store rather than in the source because the source is rebuilt
   * on every pause/resume while tasks persist here. A source-local claim set
   * would come back empty next to a task map that is still full, and the same
   * lead could be picked up twice.
   */
  claimed: Set<string>;
  /**
   * Booked appointments, keyed by lead id.
   *
   * A separate record rather than a field on the lead: §16 requires time, type,
   * advisor and status, and a cancelled appointment must remain visible as
   * cancelled rather than vanishing the moment the lead's score drops.
   */
  appointments: Map<string, Appointment>;
  /** Most recent events, newest first. Capped — this is a feed, not a ledger. */
  feed: LeadEvent[];
  telemetry: Telemetry;
  selectedLeadId: string | null;
  hoveredLeadId: string | null;
  /**
   * Leads matched by the last command. Empty set means "no active selection",
   * which the field renders as normal — NOT as "everything dimmed".
   */
  matched: Set<string>;
  /**
   * What Apsis is currently working on, in words (§17 CURRENT FOCUS).
   * Set by the command bar from the PARSED command, cleared when it is cleared.
   */
  focus: string | null;
  /** Bumped whenever any lead's score changes, so the Universe knows to re-read. */
  revision: number;
  /** Bumped on task start/finish. Separate from `revision` so agent arcs can
   *  re-read without forcing the whole lead field to recompute. */
  taskRevision: number;

  ingest: (event: LeadEvent) => void;
  startTask: (task: AgentTask) => void;
  /** Abandon all in-flight work, e.g. when the feed is paused. */
  cancelAllTasks: () => void;
  /** Resolve a task into its event. The event is what actually moves the lead. */
  completeTask: (taskId: string) => void;
  select: (leadId: string | null) => void;
  setMatched: (leadIds: string[] | null) => void;
  setFocus: (focus: string | null) => void;
  /** Dispatch a unit of agent work at a lead. Returns false if already claimed. */
  requestWork: (leadId: string, kind: LeadEventKind) => boolean;
  hover: (leadId: string | null) => void;
  applyDecay: (now: number) => void;
}

const FEED_CAP = 200;
const RATE_WINDOW_MS = 60_000;

function emptyByStage(): Record<Stage, number> {
  return STAGE_ORDER.reduce(
    (acc, s) => ((acc[s] = 0), acc),
    {} as Record<Stage, number>,
  );
}

/** Events in the trailing window. Bounded by FEED_CAP, so this stays cheap. */
function countRecent(feed: LeadEvent[], now: number): number {
  let recent = 0;
  for (const e of feed) {
    if (now - e.at > RATE_WINDOW_MS) break; // feed is newest-first
    recent++;
  }
  return recent;
}

/**
 * Adjust telemetry for ONE lead changing stage.
 *
 * The full scan below is O(total leads) and used to run on every ingested event.
 * At the default book that is invisible; at 60,000 leads and ~9 events/sec it was
 * half a million iterations a second competing with the render loop, and it cost
 * real frames. A stage change only ever moves one lead between two buckets, so
 * the counts can be carried forward instead of recounted.
 */
function telemetryAfterMove(prev: Telemetry, from: Stage, to: Stage, recent: number): Telemetry {
  if (from === to) return { ...prev, eventRate: recent };
  const byStage = { ...prev.byStage };
  byStage[from]--;
  byStage[to]++;
  return {
    total: prev.total,
    byStage,
    booked: byStage.booked,
    eventRate: recent,
  };
}

/** Full recount. Used at init and after decay, which moves many leads at once. */
function computeTelemetry(leads: Map<string, Lead>, feed: LeadEvent[], now: number): Telemetry {
  const byStage = emptyByStage();
  let booked = 0;
  for (const lead of leads.values()) {
    byStage[lead.stage]++;
    if (lead.stage === 'booked') booked++;
  }
  return { total: leads.size, byStage, booked, eventRate: countRecent(feed, now) };
}

const INITIAL_LEAD_COUNT = 4892;

/**
 * Book size, overridable with `?leads=N`.
 *
 * Kept as a real knob rather than a test-only hack: §20 asks for the experience
 * to hold up "with thousands of leads", and the only way to know where it stops
 * holding up is to be able to turn it past the default and watch.
 */
function leadCount(): number {
  if (typeof window === 'undefined') return INITIAL_LEAD_COUNT;
  const raw = new URLSearchParams(window.location.search).get('leads');
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 250_000) : INITIAL_LEAD_COUNT;
}

function init() {
  const now = Date.now();
  const leads = new Map<string, Lead>();
  const seeded = seedLeads(leadCount(), 0x5f3a21, now);
  for (const l of seeded) leads.set(l.id, l);
  // Leads that START booked need an appointment record too.
  //
  // Otherwise the centre reports "27 booked" while the ledger lists 3, because
  // only leads that passed through an `appointment_booked` event during this
  // session got a record. The seeded book represents an existing pipeline — an
  // existing pipeline has existing appointments.
  const appointments = new Map<string, Appointment>();
  for (const lead of seeded) {
    if (lead.stage === 'booked') {
      // Booked in the past, but the appointment itself is still ahead.
      appointments.set(lead.id, scheduleAppointment(lead, lead.lastEventAt, now));
    }
  }

  const order = seeded.map((l) => l.id);
  const indexOf = new Map<string, number>();
  for (let i = 0; i < order.length; i++) indexOf.set(order[i], i);
  return {
    leads,
    order,
    indexOf,
    agents: seedAgents(),
    tasks: new Map<string, AgentTask>(),
    claimed: new Set<string>(),
    appointments,
    feed: [] as LeadEvent[],
    telemetry: computeTelemetry(leads, [], now),
  };
}

export const useApsis = create<ApsisState>((set, get) => ({
  ...init(),
  selectedLeadId: null,
  hoveredLeadId: null,
  matched: new Set<string>(),
  focus: null,
  revision: 0,
  taskRevision: 0,

  ingest: (event) => {
    const { leads, feed } = get();
    const lead = leads.get(event.leadId);
    if (!lead) return;

    const score = applyEvent(lead.score, event.kind);
    const stage = stageFor(score);
    const next: Lead = {
      ...lead,
      score,
      stage,
      lastEventAt: event.at,
      ownerAgentId: event.agentId ?? lead.ownerAgentId,
      appointmentAt:
        event.kind === 'appointment_booked'
          ? event.at
          : event.kind === 'appointment_cancelled'
            ? null
            : lead.appointmentAt,
    };

    // Appointments are created and retired here, alongside the score change that
    // caused them, so the two can never disagree about whether a lead is booked.
    const { appointments } = get();
    if (event.kind === 'appointment_booked') {
      appointments.set(lead.id, scheduleAppointment(next, event.at));
    } else if (event.kind === 'appointment_cancelled') {
      const existing = appointments.get(lead.id);
      if (existing) appointments.set(lead.id, { ...existing, status: 'cancelled' });
    }

    // Mutating the Map in place and bumping `revision` beats cloning a
    // 4,892-entry Map on every event — at a realistic event rate that clone is
    // the single biggest source of GC pressure in the app.
    leads.set(lead.id, next);
    const nextFeed = [event, ...feed].slice(0, FEED_CAP);

    set((s) => ({
      feed: nextFeed,
      telemetry: telemetryAfterMove(
        s.telemetry,
        lead.stage,
        stage,
        countRecent(nextFeed, event.at),
      ),
      revision: s.revision + 1,
    }));
  },

  startTask: (task) => {
    const { tasks, claimed } = get();
    if (claimed.has(task.leadId)) return;
    tasks.set(task.id, task);
    claimed.add(task.leadId);
    set((s) => ({ taskRevision: s.taskRevision + 1 }));
  },

  cancelAllTasks: () => {
    const { tasks, claimed } = get();
    if (tasks.size === 0) return;
    tasks.clear();
    claimed.clear();
    set((s) => ({ taskRevision: s.taskRevision + 1 }));
  },

  completeTask: (taskId) => {
    const { tasks } = get();
    const task = tasks.get(taskId);
    if (!task) return;
    tasks.delete(taskId);
    get().claimed.delete(task.leadId);
    set((s) => ({ taskRevision: s.taskRevision + 1 }));
    // The task is bookkeeping; the EVENT is what the domain reacts to. Keeping
    // these separate is what lets a real executor replace the timer without the
    // scoring engine noticing.
    get().ingest({
      id: `evt_${task.id}`,
      leadId: task.leadId,
      kind: task.emits,
      at: Date.now(),
      agentId: task.agentId,
    });
  },

  select: (leadId) => set({ selectedLeadId: leadId }),

  setMatched: (leadIds) =>
    set({ matched: leadIds === null ? new Set<string>() : new Set(leadIds) }),

  setFocus: (focus) => set({ focus }),

  requestWork: (leadId, kind) => {
    const state = get();
    const lead = state.leads.get(leadId);
    if (!lead) return false;
    const agentId = agentFor(kind, lead);
    if (!agentId || state.claimed.has(leadId)) return false;
    const startedAt = Date.now();
    state.startTask({
      id: `task_cmd_${leadId}_${startedAt}`,
      agentId,
      leadId,
      startedAt,
      // Commanded work is spread over a window rather than firing as one block —
      // a hundred agents completing on the same millisecond is not a sequence.
      dueAt: startedAt + taskDuration(kind, Math.min(0.99, (startedAt % 1000) / 1000)),
      emits: kind,
    });
    return true;
  },

  // Guarded against redundant writes. Pointer move fires at device rate over a
  // field of thousands of points; setting the same id again would re-render the
  // detail panel on every one of those frames for no change in what it shows.
  hover: (leadId) =>
    set((s) => (s.hoveredLeadId === leadId ? s : { hoveredLeadId: leadId })),

  applyDecay: (now) => {
    const { leads } = get();
    let changed = 0;
    for (const [id, lead] of leads) {
      const score = decayedScore(lead.score, lead.lastEventAt, now);
      if (score !== lead.score) {
        leads.set(id, { ...lead, score, stage: stageFor(score) });
        changed++;
      }
    }
    if (changed === 0) return;
    set((s) => ({
      telemetry: computeTelemetry(leads, s.feed, now),
      revision: s.revision + 1,
    }));
  },
}));

/** Non-reactive read, for the render loop. Subscribing per frame would thrash React. */
export const readLeads = () => useApsis.getState().leads;
export const readOrder = () => useApsis.getState().order;
export const readIndexOf = () => useApsis.getState().indexOf;
export const readTasks = () => useApsis.getState().tasks;
export const readMatched = () => useApsis.getState().matched;

/**
 * Appointments in chronological order, with elapsed ones reported as held.
 *
 * Status is derived at read time rather than written by a timer: an appointment
 * becomes "held" because its slot passed, which is a fact about the clock, not
 * an event anything needs to emit.
 */
/**
 * Whether Apsis is working right now (§17 APSIS STATE).
 *
 * Derived from in-flight agent tasks and recent event throughput, not stored.
 * A stored flag would need something to remember to clear it, and the moment it
 * fell out of sync the most prominent word on the panel would be a lie.
 */
export function systemState(): 'processing' | 'idle' {
  const { tasks, telemetry } = useApsis.getState();
  return tasks.size > 0 || telemetry.eventRate > 0 ? 'processing' : 'idle';
}

export function upcomingAppointments(now: number): Appointment[] {
  return [...useApsis.getState().appointments.values()]
    .map((a) => withElapsedStatus(a, now))
    .sort((a, b) => a.at - b.at);
}

export type { LeadEventKind };
