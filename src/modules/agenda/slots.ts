import { CalendarClient } from './calendar.client';
import { getWindowForDayIso } from '../../lib/horario';

const TZ = 'America/Mexico_City';

export interface AvailableSlot {
  startIso: string;
  endIso: string;
  startHour: number;
}

// La tabla de horarios por día vive en lib/horario.ts (fuente única compartida
// con la ventana de llamadas), configurable vía env HORARIO_SEMANAL.

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
 * given duration (default 1 h). Only hours within the day's window are offered;
 * slots that would run past the closing hour are never included.
 *
 * Regla de corte (la cita debe CABER completa):
 *   virtual  (1 h) → último inicio permitido = close - 1  (p. ej. 19:00 L-V, 11:00 Sáb)
 *   presencial (2 h) → último inicio permitido = close - 2  (p. ej. 18:00 L-V, 10:00 Sáb)
 *
 * Devuelve [] para días inhábiles (domingo) o si la ventana no admite la duración.
 */
export async function getAvailableSlots(
  dayIso: string,
  client: CalendarClient = new CalendarClient(),
  durationHours = 1,
): Promise<AvailableSlot[]> {
  const window = getWindowForDayIso(dayIso);
  if (!window) return []; // día inhábil

  const { open, close } = window;
  // La cita debe caber completa: el último inicio posible es close - durationHours.
  const lastStart = close - durationHours;
  if (lastStart < open) return []; // duración no cabe en la ventana

  const busy = await client.getBusySlots(dayIso);
  const busyRanges = busy.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const slots: AvailableSlot[] = [];

  for (let hour = open; hour <= lastStart; hour += 1) {
    const startIso = `${dayIso}T${String(hour).padStart(2, '0')}:00:00`;
    const endHour = hour + durationHours;
    const endIso = `${dayIso}T${String(endHour).padStart(2, '0')}:00:00`;

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
  horas: string[];         // ["10:00", "11:00", ...]
}

/**
 * Iterates from tomorrow forward (up to maxDays) until it finds
 * up to `limit` days that have at least one free slot of `durationHours` in
 * Calendar. Used by handleVerificarDisponibilidad.
 *
 * Días inhábiles (domingo) se saltan automáticamente — no generan entradas vacías.
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
