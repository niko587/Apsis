/**
 * The Appointment Centre (§16).
 *
 * "The center is the ultimate goal." This is the ledger behind that centre: the
 * five fields §16 names — name, time, type, advisor, status — for every booked
 * appointment, soonest first.
 *
 * It reads from the same store the Universe does, so the count here and the count
 * under the Core are the same number by construction rather than by coincidence.
 */

import { useMemo } from 'react';
import { useApsis, upcomingAppointments } from '../state/store';
import { useThrottledRevision } from './useThrottledRevision';
import type { AppointmentStatus } from '../domain/appointments';

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  confirmed: 'Confirmed',
  held: 'Held',
  cancelled: 'Cancelled',
  no_show: 'No show',
};

/** Weekday + time, e.g. "Tue 10:30". Same day reads as "Today 10:30". */
function slotLabel(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export function AppointmentCentre() {
  const revision = useThrottledRevision();
  const select = useApsis((s) => s.select);
  const selectedId = useApsis((s) => s.selectedLeadId);

  // Recomputed on the throttled revision: appointments only change when an
  // appointment_booked or _cancelled event lands, which is rare relative to the
  // event stream, but the status derivation depends on the clock too.
  const { rows, confirmed, total } = useMemo(() => {
    const all = upcomingAppointments(Date.now());
    return {
      rows: all.slice(0, 12),
      confirmed: all.filter((a) => a.status === 'confirmed').length,
      total: all.length,
    };
  }, [revision]);

  return (
    <section className="panel">
      <h2>
        Qualified Booked Appointments
        <span className="h2-aside">{confirmed} upcoming</span>
      </h2>

      {rows.length === 0 ? (
        <p className="muted">
          No appointments booked yet. Leads reach the centre by being booked, not by
          being worked.
        </p>
      ) : (
        <ul className="appts">
          {rows.map((a) => (
            <li
              key={a.leadId}
              className={[
                `appt-${a.status}`,
                selectedId === a.leadId ? 'picked' : '',
              ].join(' ')}
              onClick={() => select(a.leadId)}
            >
              <div className="appt-top">
                <span className="appt-name">{a.leadName}</span>
                <span className="appt-time">{slotLabel(a.at, Date.now())}</span>
              </div>
              <div className="appt-bottom">
                <span className="appt-type">{a.type}</span>
                <span className="appt-advisor">{a.advisor}</span>
                <span className={`appt-status appt-status-${a.status}`}>
                  {STATUS_LABEL[a.status]}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > rows.length && (
        <p className="ll-more">Showing the next {rows.length} of {total}.</p>
      )}
    </section>
  );
}
