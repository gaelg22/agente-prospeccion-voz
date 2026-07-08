import { CalendarClient } from './calendar.client';

const TZ = 'America/Mexico_City';
const SLOT_DURATION_HOURS = 1;
const OPEN_HOUR = 9;
const CLOSE_HOUR = 21;

export interface AvailableSlot {
  startIso: string;
  endIso: string;
  startHour: number;
}

/**
 * Returns available 1-hour slots for a given date (YYYY-MM-DD, MX timezone).
 * Slots: 09:00, 10:00, …, 20:00 — minus any busy periods.
 */
export async function getAvailableSlots(
  dayIso: string,
  client: CalendarClient = new CalendarClient(),
): Promise<AvailableSlot[]> {
  const busy = await client.getBusySlots(dayIso);

  const busyRanges = busy.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const slots: AvailableSlot[] = [];

  for (let hour = OPEN_HOUR; hour < CLOSE_HOUR; hour += SLOT_DURATION_HOURS) {
    const startIso = `${dayIso}T${String(hour).padStart(2, '0')}:00:00`;
    const endHour = hour + SLOT_DURATION_HOURS;
    const endIso = `${dayIso}T${String(endHour).padStart(2, '0')}:00:00`;

    const slotStart = new Date(`${startIso}-06:00`).getTime(); // approximate MX CST
    const slotEnd = new Date(`${endIso}-06:00`).getTime();

    const isBusy = busyRanges.some(
      (b) => slotStart < b.end && slotEnd > b.start,
    );

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
