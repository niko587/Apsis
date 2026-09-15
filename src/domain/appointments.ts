/**
 * Appointments (§16).
 *
 * The centre of the Universe is a qualified booked appointment, so an
 * appointment has to be a real record rather than the timestamp the lead used to
 * carry. §16 names the fields it must show: name, time, type, advisor, status.
 *
 * Scheduling is deterministic — derived from the lead id and the booking time,
 * never from `Math.random`. Two consequences worth having: the same booking
 * always produces the same slot, so tests can assert on it; and a lead's advisor
 * does not change every render.
 */

import type { Lead } from './types';
import { stableHash } from './seed';

export type AppointmentStatus = 'confirmed' | 'held' | 'cancelled' | 'no_show';

export interface Appointment {
  readonly leadId: string;
  readonly leadName: string;
  /** Scheduled start, epoch ms. Always a future business-hours slot at booking. */
  readonly at: number;
  readonly type: string;
  readonly advisor: string;
  readonly status: AppointmentStatus;
  readonly bookedAt: number;
}

/** Appointment type follows the lead's segment — that is what the meeting is about. */
const TYPE_FOR_SEGMENT: Readonly<Record<string, string>> = {
  'Family Coverage': 'Family plan review',
  Individual: 'Individual plan review',
  Medicare: 'Medicare eligibility',
  'Small Business': 'Group benefits consult',
  'Self-Employed': 'Self-employed coverage',
  Supplemental: 'Supplemental options',
  'Dental + Vision': 'Dental & vision review',
};

const ADVISORS = [
  'D. Whitfield',
  'R. Castellanos',
  'M. Okonkwo',
  'S. Lindqvist',
  'A. Ferreira',
  'J. Halloran',
];

const HOUR = 1000 * 60 * 60;

export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 17;
/** Minimum notice. Nobody books an appointment for twenty minutes from now. */
export const MIN_NOTICE_MS = 24 * HOUR;

/**
 * Next bookable slot at least {@link MIN_NOTICE_MS} out.
 *
 * Walks forward day by day rather than computing an offset, because weekends and
 * the business-hours window make the arithmetic version wrong in exactly the
 * cases that matter (booking on a Friday evening, booking at 16:58).
 */
export function nextSlot(from: number, offsetSlots: number): number {
  const d = new Date(from + MIN_NOTICE_MS);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);

  const SLOT_MS = 30 * 60 * 1000;
  let remaining = offsetSlots;

  for (let guard = 0; guard < 800; guard++) {
    const day = d.getDay();
    const nextDayStart = () => {
      d.setDate(d.getDate() + 1);
      d.setHours(BUSINESS_START_HOUR, 0, 0, 0);
    };

    if (day === 0 || day === 6) {
      nextDayStart();
      continue;
    }
    if (d.getHours() < BUSINESS_START_HOUR) {
      d.setHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    if (d.getHours() >= BUSINESS_END_HOUR) {
      nextDayStart();
      continue;
    }
    if (remaining <= 0) return d.getTime();

    // Consume only the slots that actually FIT in what is left of today, then
    // carry the remainder into tomorrow.
    //
    // An earlier version added `min(remaining, slotsPerDay)` half-hours in one
    // jump. Any offset that overshot closing time landed outside business hours,
    // and the next iteration reset to tomorrow at 09:00 — silently discarding the
    // leftover. Every overshooting offset therefore collapsed onto the same
    // morning slot, which is why twenty leads produced five distinct times.
    const endToday = new Date(d);
    endToday.setHours(BUSINESS_END_HOUR, 0, 0, 0);
    const slotsLeftToday = Math.floor((endToday.getTime() - d.getTime()) / SLOT_MS);

    if (remaining < slotsLeftToday) {
      d.setMinutes(d.getMinutes() + remaining * 30);
      return d.getTime();
    }
    remaining -= slotsLeftToday;
    nextDayStart();
  }
  // Unreachable in practice; returning the walked value beats throwing here.
  return d.getTime();
}

/**
 * @param bookedAt   when the booking was made (recorded as-is)
 * @param scheduleFrom when to search for a slot from; defaults to `bookedAt`.
 *
 * These come apart for the seeded book. A lead that was booked ninety days ago
 * still has an appointment in the FUTURE — scheduling it from its booking time
 * puts the slot in the past and the whole centre reads as "Held", which is not
 * what a live pipeline looks like.
 */
export function scheduleAppointment(
  lead: Lead,
  bookedAt: number,
  scheduleFrom: number = bookedAt,
): Appointment {
  const h = stableHash(lead.id);
  return {
    leadId: lead.id,
    leadName: lead.name,
    // Spread across the next ~2 working days so the centre does not stack every
    // appointment on one slot.
    at: nextSlot(scheduleFrom, Math.floor(h * 32)),
    type: TYPE_FOR_SEGMENT[lead.segment] ?? 'Coverage review',
    advisor: ADVISORS[Math.floor(h * ADVISORS.length) % ADVISORS.length],
    status: 'confirmed',
    bookedAt,
  };
}

/** Appointments whose slot has passed are held, not still "confirmed". */
export function withElapsedStatus(a: Appointment, now: number): Appointment {
  if (a.status !== 'confirmed') return a;
  return now >= a.at ? { ...a, status: 'held' } : a;
}

export const APPOINTMENT_TYPES = TYPE_FOR_SEGMENT;
export { ADVISORS };
