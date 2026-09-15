import { describe, expect, it } from 'vitest';
import {
  BUSINESS_END_HOUR,
  BUSINESS_START_HOUR,
  MIN_NOTICE_MS,
  nextSlot,
  scheduleAppointment,
  withElapsedStatus,
} from './appointments';
import { seedLeads } from './seed';

const leads = seedLeads(40, 0x5f3a21, 1_700_000_000_000);

/** Monday 2023-11-13 10:00 local. */
const MONDAY_10AM = new Date(2023, 10, 13, 10, 0, 0, 0).getTime();
/** Friday 2023-11-17 16:45 local — the case naive offset arithmetic gets wrong. */
const FRIDAY_LATE = new Date(2023, 10, 17, 16, 45, 0, 0).getTime();

const isBusinessSlot = (t: number) => {
  const d = new Date(t);
  const day = d.getDay();
  return (
    day !== 0 &&
    day !== 6 &&
    d.getHours() >= BUSINESS_START_HOUR &&
    d.getHours() < BUSINESS_END_HOUR
  );
};

describe('nextSlot', () => {
  it('always lands inside business hours on a weekday', () => {
    for (let offset = 0; offset < 40; offset++) {
      for (const from of [MONDAY_10AM, FRIDAY_LATE]) {
        expect(isBusinessSlot(nextSlot(from, offset))).toBe(true);
      }
    }
  });

  it('never books with less than the minimum notice', () => {
    for (let offset = 0; offset < 20; offset++) {
      expect(nextSlot(MONDAY_10AM, offset)).toBeGreaterThanOrEqual(
        MONDAY_10AM + MIN_NOTICE_MS,
      );
    }
  });

  it('skips the weekend when booked late on a Friday', () => {
    // 24h notice from Friday 16:45 lands Saturday evening; the slot must move to
    // Monday. This is the case an offset-arithmetic version gets wrong.
    const slot = new Date(nextSlot(FRIDAY_LATE, 0));
    expect(slot.getDay()).toBe(1);
  });

  it('is monotonic in offset', () => {
    let prev = -Infinity;
    for (let offset = 0; offset < 30; offset++) {
      const t = nextSlot(MONDAY_10AM, offset);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});

describe('scheduleAppointment', () => {
  it('is deterministic for a given lead and booking time', () => {
    const a = scheduleAppointment(leads[0], MONDAY_10AM);
    const b = scheduleAppointment(leads[0], MONDAY_10AM);
    expect(a).toEqual(b);
  });

  it('fills every field §16 requires', () => {
    const a = scheduleAppointment(leads[1], MONDAY_10AM);
    expect(a.leadName).toBe(leads[1].name);
    expect(a.at).toBeGreaterThan(MONDAY_10AM);
    expect(a.type).toBeTruthy();
    expect(a.advisor).toBeTruthy();
    expect(a.status).toBe('confirmed');
  });

  it('derives the appointment type from the lead segment', () => {
    const family = leads.find((l) => l.segment === 'Family Coverage');
    if (family) expect(scheduleAppointment(family, MONDAY_10AM).type).toMatch(/family/i);
  });

  it('spreads bookings rather than stacking them on one slot', () => {
    const slots = new Set(
      leads.slice(0, 20).map((l) => scheduleAppointment(l, MONDAY_10AM).at),
    );
    expect(slots.size).toBeGreaterThan(5);
  });

  it('always schedules into a valid business slot', () => {
    for (const lead of leads) {
      expect(isBusinessSlot(scheduleAppointment(lead, FRIDAY_LATE).at)).toBe(true);
    }
  });
});

describe('status', () => {
  it('reports a passed appointment as held', () => {
    const a = scheduleAppointment(leads[0], MONDAY_10AM);
    expect(withElapsedStatus(a, a.at - 1).status).toBe('confirmed');
    expect(withElapsedStatus(a, a.at + 1).status).toBe('held');
  });

  it('never resurrects a cancelled appointment', () => {
    const a = { ...scheduleAppointment(leads[0], MONDAY_10AM), status: 'cancelled' as const };
    expect(withElapsedStatus(a, a.at + 1).status).toBe('cancelled');
  });
});
