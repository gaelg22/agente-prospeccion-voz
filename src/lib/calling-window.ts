const TZ = 'America/Mexico_City';
const OPEN_HOUR = 9;   // 09:00 inclusive
const CLOSE_HOUR = 21; // 21:00 exclusive
const MORNING_END_HOUR = 15; // split point for retry slot logic

/**
 * Returns true if `now` falls within the allowed calling window:
 * Monday–Sunday 09:00–20:59 America/Mexico_City.
 */
export function isInCallingWindow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(getPart(parts, 'hour'), 10);
  const minute = parseInt(getPart(parts, 'minute'), 10);
  const totalMinutes = hour * 60 + minute;

  return totalMinutes >= OPEN_HOUR * 60 && totalMinutes < CLOSE_HOUR * 60;
}

/**
 * Determines whether a given time is in the morning slot (09:00–14:59 MX).
 * Used to compute the "opposite slot" for next-day retries.
 */
export function isMorningSlot(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(getPart(parts, 'hour'), 10);
  return hour < MORNING_END_HOUR;
}

/**
 * Returns the Date for the start of the opposite slot on the next calendar day.
 * Morning call → next day 15:00 MX
 * Afternoon/evening call → next day 09:00 MX
 */
export function nextDayOppositeSlot(from: Date = new Date()): Date {
  const targetHour = isMorningSlot(from) ? MORNING_END_HOUR : OPEN_HOUR;

  // Build a "next day at targetHour:00 MX" date using Intl formatter in reverse
  // Approach: get the current date in MX, add 1 day, set hour via UTC offset math
  const mxDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(from); // e.g. "2025-07-09"

  const [year, month, day] = mxDateStr.split('-').map(Number) as [number, number, number];

  // Add one day
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(nextDay);

  // Parse back as a UTC instant representing "targetHour:00 in TZ"
  // We construct an ISO string and let Intl resolve the offset
  const candidate = new Date(`${nextDayStr}T${String(targetHour).padStart(2, '0')}:00:00`);

  // The above is a local-time parse (no timezone info), so we compute the UTC
  // equivalent by finding the UTC offset at that moment in MX.
  return toUtcAtMxTime(nextDayStr, targetHour);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '0';
}

/**
 * Converts a "YYYY-MM-DD" date + hour in America/Mexico_City to a UTC Date.
 * Uses a binary-search-free approximation valid for standard MX offsets (-6/-5).
 */
function toUtcAtMxTime(dateStr: string, hour: number): Date {
  // Try UTC-6 (CST) first, then verify with Intl
  const offsets = [-6, -5];
  for (const offset of offsets) {
    const utcMs = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`) - offset * 3_600_000;
    const probe = new Date(utcMs);
    const probeHour = parseInt(
      getPart(
        new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).formatToParts(probe),
        'hour',
      ),
      10,
    );
    if (probeHour === hour) return probe;
  }
  // Fallback: return using the -6 assumption
  return new Date(Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`) + 6 * 3_600_000);
}
