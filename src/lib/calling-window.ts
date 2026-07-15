/**
 * calling-window.ts
 *
 * Ventana de llamadas salientes — America/Mexico_City.
 *
 * La tabla de horarios por día vive en lib/horario.ts (fuente única compartida
 * con los slots de citas) y es configurable vía env HORARIO_SEMANAL. Defaults:
 *   Lunes–Viernes  10:00–20:00  (exclusive)
 *   Sábado         08:00–12:00  (exclusive)
 *   Domingo        inhábil
 */

import { getWindowForDow } from './horario';

const TZ = 'America/Mexico_City';

// ─── Helpers de fecha MX ──────────────────────────────────────────────────────

function getMxParts(now: Date): { hour: number; minute: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(getPart(parts, 'hour'), 10);
  const minute = parseInt(getPart(parts, 'minute'), 10);
  const weekdayStr = getPart(parts, 'weekday'); // "Sun","Mon",...

  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dow = dowMap[weekdayStr] ?? -1;

  return { hour, minute, dow };
}

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '0';
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Devuelve true si `now` cae dentro de la ventana de llamadas permitida
 * según la tabla de horarios por día de la semana.
 */
export function isInCallingWindow(now: Date = new Date()): boolean {
  const { hour, minute, dow } = getMxParts(now);
  const window = getWindowForDow(dow);
  if (!window) return false; // día inhábil

  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= window.open * 60 && totalMinutes < window.close * 60;
}

/**
 * Determina si el momento está en el tramo de "mañana" de la ventana del día.
 * Se define como la primera mitad de la ventana abierta.
 * Para L-V (10–20): mañana = 10–14:59. Para Sáb (8–12): mañana = 8–9:59.
 * Si el día es inhábil, retorna false.
 */
export function isMorningSlot(now: Date = new Date()): boolean {
  const { hour, dow } = getMxParts(now);
  const window = getWindowForDow(dow);
  if (!window) return false;

  const midpoint = Math.floor((window.open + window.close) / 2);
  return hour >= window.open && hour < midpoint;
}

/**
 * Devuelve la fecha UTC correspondiente al inicio del "slot opuesto" al día
 * siguiente hábil.
 *   - Si la llamada fue en el tramo de mañana → el slot opuesto es la tarde
 *     (segunda mitad de la ventana del día siguiente hábil).
 *   - Si fue en la tarde/noche → el slot opuesto es la apertura del día
 *     siguiente hábil.
 *
 * Salta días inhábiles (domingo) hasta encontrar el primer día hábil siguiente.
 */
export function nextDayOppositeSlot(from: Date = new Date()): Date {
  const morning = isMorningSlot(from);

  const mxDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(from);

  const [year, month, day] = mxDateStr.split('-').map(Number) as [number, number, number];

  // Buscar el siguiente día hábil (máx 7 saltos para no loop infinito)
  for (let offset = 1; offset <= 7; offset++) {
    const nextDay = new Date(Date.UTC(year, month - 1, day + offset));
    const nextDayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(nextDay);

    const nextDow = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      weekday: 'short',
    }).format(nextDay);
    const dowMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const dow = dowMap[nextDow] ?? -1;
    const window = getWindowForDow(dow);
    if (!window) continue; // día inhábil, saltamos

    const midpoint = Math.floor((window.open + window.close) / 2);
    const targetHour = morning ? midpoint : window.open;

    return toUtcAtMxTime(nextDayStr, targetHour);
  }

  // Fallback: mañana 10:00 MX (no debería llegarse aquí)
  const fallbackDay = new Date(Date.UTC(year, month - 1, day + 1));
  const fallbackStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(fallbackDay);
  return toUtcAtMxTime(fallbackStr, 10);
}

// ─── Utilidad interna ─────────────────────────────────────────────────────────

/**
 * Convierte "YYYY-MM-DD" + hora en America/Mexico_City a un instante UTC.
 * Prueba los offsets CST (-6) y CDT (-5) y verifica con Intl.
 */
function toUtcAtMxTime(dateStr: string, hour: number): Date {
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
  // Fallback CST
  return new Date(Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`) + 6 * 3_600_000);
}
