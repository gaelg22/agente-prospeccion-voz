import { CalendarClient } from './calendar.client';

const TZ = 'America/Mexico_City';
const OPEN_HOUR = 9;
const CLOSE_HOUR = 21;

export interface AvailableSlot {
  startIso: string;
  endIso: string;
  startHour: number;
}

// ─── Conversión correcta de hora local MX → UTC ───────────────────────────────
// Resuelve el offset real del día usando Intl (maneja CST -6 y CDT -5).
function mxLocalToUtcMs(dayIso: string, hour: number): number {
  const offsets = [-6, -5];
  for (const offset of offsets) {
    const utcMs =
      Date.parse(`${dayIso}T${String(hour).padStart(2, '0')}:00:00Z`) -
      offset * 3_600_000;
    const probe = new Date(utcMs);
    const probeHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour: 'numeric',
        hour12: false,
      })
        .formatToParts(probe)
        .find((p) => p.type === 'hour')?.value ?? '0',
      10,
    );
    if (probeHour === hour) return utcMs;
  }
  // Fallback CST
  return (
    Date.parse(`${dayIso}T${String(hour).padStart(2, '0')}:00:00Z`) +
    6 * 3_600_000
  );
}

/**
 * Returns available slots for a given date (YYYY-MM-DD, MX timezone) of the
 * given duration (default 1 h). Start hours go every hour from 09:00, and the
 * last slot must END by 21:00 (so a 2 h slot starts at most at 19:00) — minus
 * any busy periods from Calendar. `durationHours` = 1 (virtual) o 2 (presencial).
 */
export async function getAvailableSlots(
  dayIso: string,
  client: CalendarClient = new CalendarClient(),
  durationHours = 1,
): Promise<AvailableSlot[]> {
  const busy = await client.getBusySlots(dayIso);

  const busyRanges = busy.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const slots: AvailableSlot[] = [];

  for (let hour = OPEN_HOUR; hour + durationHours <= CLOSE_HOUR; hour += 1) {
    const startIso = `${dayIso}T${String(hour).padStart(2, '0')}:00:00`;
    const endHour = hour + durationHours;
    const endIso = `${dayIso}T${String(endHour).padStart(2, '0')}:00:00`;

    // Usar la conversión correcta a UTC (respeta CDT/CST)
    const slotStart = mxLocalToUtcMs(dayIso, hour);
    const slotEnd = mxLocalToUtcMs(dayIso, endHour);

    const isBusy = busyRanges.some((b) => slotStart < b.end && slotEnd > b.start);

    if (!isBusy) {
      slots.push({ startIso, endIso, startHour: hour });
    }
  }

  return slots;
}

/**
 * Formats a date as "YYYY-MM-DD" in Mexico City timezone.
 */
export function formatDateMx(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export interface DayWithSlots {
  fecha: string;           // YYYY-MM-DD
  horas: string[];         // ["09:00", "11:00", ...]
}

/**
 * Iterates from tomorrow forward (up to maxDays) until it finds
 * up to `limit` days that have at least one free slot of `durationHours` in
 * Calendar. Used by handleVerificarDisponibilidad; la duración depende de la
 * modalidad ya elegida (1 h virtual, 2 h presencial).
 */
export async function getNextDaysWithSlots(
  client: CalendarClient = new CalendarClient(),
  limit = 2,
  maxDays = 14,
  durationHours = 1,
): Promise<DayWithSlots[]> {
  const result: DayWithSlots[] = [];
  const today = new Date();

  for (let offset = 1; offset <= maxDays && result.length < limit; offset++) {
    const candidate = new Date(today);
    candidate.setUTCDate(today.getUTCDate() + offset);
    const dayIso = formatDateMx(candidate);

    const slots = await getAvailableSlots(dayIso, client, durationHours);
    if (slots.length > 0) {
      result.push({
        fecha: dayIso,
        horas: slots.map((s) => `${String(s.startHour).padStart(2, '0')}:00`),
      });
    }
  }

  return result;
}
