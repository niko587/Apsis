/**
 * Apsis domain types.
 *
 * The product metaphor is orbital. An *apsis* is a point of extreme approach on
 * an orbit: apoapsis is the farthest point, periapsis the nearest. A cold lead
 * sits at apoapsis on the outer rim; a qualified booked appointment is periapsis
 * at the center. Everything here describes a lead's position on that line.
 *
 * Nothing in this module knows about React, Three.js, or rendering. The 3D layer
 * derives position from this state — never the other way around.
 */

/** Where a lead sits on the journey from cold to booked. Ordered, outer → inner. */
export type Stage =
  | 'cold'
  | 'contacted'
  | 'engaged'
  | 'qualified'
  | 'hot'
  | 'appointment_ready'
  | 'booked';

export const STAGE_ORDER: readonly Stage[] = [
  'cold',
  'contacted',
  'engaged',
  'qualified',
  'hot',
  'appointment_ready',
  'booked',
] as const;

export interface StageSpec {
  readonly id: Stage;
  readonly label: string;
  /**
   * Continuous band, half-open as [lo, hi) — except `booked`, whose `hi` of 100
   * is inclusive because 100 is the top of the scale.
   *
   * These must tile [0, 100] over the REALS, not just the integers. An earlier
   * version used inclusive integer bands (0-20, 21-40, …), which left score 20.5
   * belonging to no stage at all; that gap made the radius non-monotonic, so a
   * lead ticking from 20.5 to 21 jumped *outward*. Bands are adjacent now:
   * each `hi` is exactly the next stage's `lo`.
   */
  readonly lo: number;
  readonly hi: number;
  /** Emissive hue for the 3D layer and the legend. sRGB hex. */
  readonly color: string;
}

/**
 * Score bands, matching the design reference legend.
 *
 * The bands narrow as they approach the center on purpose: the last nine points
 * of score cover three stages. Late-funnel progress is harder to earn and more
 * visually significant, so a small score change near the center means more.
 */
export const STAGES: Readonly<Record<Stage, StageSpec>> = {
  cold: { id: 'cold', label: 'Cold', lo: 0, hi: 21, color: '#2f6bff' },
  contacted: { id: 'contacted', label: 'Contacted', lo: 21, hi: 41, color: '#12c8e0' },
  engaged: { id: 'engaged', label: 'Engaged', lo: 41, hi: 61, color: '#ffd23f' },
  qualified: { id: 'qualified', label: 'Qualified', lo: 61, hi: 76, color: '#ff9a1f' },
  hot: { id: 'hot', label: 'Hot', lo: 76, hi: 91, color: '#ff3b57' },
  appointment_ready: {
    id: 'appointment_ready',
    label: 'Appointment Ready',
    lo: 91,
    hi: 99,
    color: '#ff45d0',
  },
  booked: { id: 'booked', label: 'Booked', lo: 99, hi: 100, color: '#2fe08a' },
};

/** Legend text, e.g. "21–40". Derived so the legend can never disagree with the bands. */
export function bandLabel(stage: Stage): string {
  const { lo, hi, id } = STAGES[stage];
  return id === 'booked' ? `${lo}–${hi}` : `${lo}–${hi - 1}`;
}

/**
 * The highest score reachable by engagement alone.
 *
 * Touches asymptote here; only an `appointment_booked` event crosses into the
 * booked band. Periapsis has to be earned by a booking, not by volume.
 *
 * Must be STRICTLY BELOW `booked.lo`, not equal to it. Set to `appointment_ready.hi`
 * (= `booked.lo` = 99) the asymptote is the booked threshold itself, so a long
 * enough run of touches converges onto 99 and `stageFor` reports `booked` — the
 * exact failure this constant exists to prevent. One point of clearance keeps the
 * limit inside `appointment_ready` no matter how many events arrive.
 */
export const TOUCH_CEILING = STAGES.booked.lo - 1;

/** Temperature is the raw 0-100 score. Stage is derived from it, never set directly. */
export type Score = number;

export interface Lead {
  readonly id: string;
  readonly name: string;
  readonly company: string | null;
  readonly location: string;
  readonly segment: string;
  /**
   * Marketing campaign that produced the lead (§15 drill dimension).
   * Derived deterministically from the lead id, not from the seeded RNG stream.
   */
  readonly campaign: string;
  /**
   * How the lead was acquired — referral, paid search, partner and so on.
   *
   * Named `acquisitionSource`, never `source`, so it can never be confused with
   * `LeadSource`, the runtime transport that produces events. They are unrelated
   * concepts that would otherwise collide in every search for "source".
   */
  readonly acquisitionSource: string;
  /** 0-100. The single source of truth for radial position and stage. */
  readonly score: Score;
  readonly stage: Stage;
  /** Stable angular position on the disc, radians. Assigned once at ingest. */
  readonly theta: number;
  /** Orbital inclination, radians. Gives the field volume instead of a flat ring. */
  readonly inclination: number;
  /** Epoch ms of the most recent event. Drives the "stale" treatment. */
  readonly lastEventAt: number;
  readonly createdAt: number;
  /** Set once the lead reaches `booked`. */
  readonly appointmentAt: number | null;
  readonly ownerAgentId: string | null;

  // --- §14 lead detail ---
  readonly phone: string;
  readonly email: string;
  readonly age: number;
  readonly occupation: string;
  /** What they have today. Null means uninsured, which is itself a signal. */
  readonly currentCoverage: string | null;
  readonly preferredContact: 'phone' | 'sms' | 'email';
  /** Stated needs, e.g. "PPO preferred", "January timeframe". */
  readonly needs: readonly string[];
  /** 0-1. Distinct from score: intent is what they WANT, score is how far along. */
  readonly intent: number;
}

/**
 * Every way a lead's state can legally change.
 *
 * This is the whole vocabulary. A lead never moves because a timer fired — it
 * moves because one of these arrived, the scoring engine recomputed, and the
 * derived radius changed. A real CRM integration emits exactly these.
 */
export type LeadEventKind =
  | 'ingested'
  | 'contacted'
  | 'opened'
  | 'clicked'
  | 'replied'
  | 'call_connected'
  | 'call_no_answer'
  | 'qualified'
  | 'objection'
  | 'appointment_offered'
  | 'appointment_booked'
  | 'appointment_cancelled'
  | 'went_cold'
  | 'unsubscribed';

export interface LeadEvent {
  readonly id: string;
  readonly leadId: string;
  readonly kind: LeadEventKind;
  readonly at: number;
  /** Which AI agent caused this, if any. Null for inbound/lead-initiated events. */
  readonly agentId: string | null;
  readonly note?: string;
}

export type AgentKind =
  | 'call'
  | 'sms'
  | 'email'
  | 'follow_up'
  | 'qualification'
  | 'booking'
  | 'reactivation';

export interface Agent {
  readonly id: string;
  readonly kind: AgentKind;
  readonly label: string;
  readonly color: string;
}

/**
 * One unit of agent work, in flight.
 *
 * A task is created when an agent picks up a lead and removed when it resolves
 * into a `LeadEvent`. While it exists the agent is busy and the Universe draws
 * an arc from that agent to that lead, so "what is the network doing right now"
 * is answerable by reading the task set — not by inferring it from past events.
 */
export interface AgentTask {
  readonly id: string;
  readonly agentId: string;
  readonly leadId: string;
  readonly startedAt: number;
  /** Wall-clock ms at which this task resolves. */
  readonly dueAt: number;
  readonly emits: LeadEventKind;
}
