// ─── Horario de atención — fuente única ──────────────────────────────────────
// Tabla de ventanas por día de la semana (America/Mexico_City) usada TANTO por
// la ventana de llamadas (calling-window.ts) como por los slots de citas
// (agenda/slots.ts). Configurable vía env HORARIO_SEMANAL; defaults:
//
//   Lunes–Viernes  10:00–20:00
//   Sábado         08:00–12:00
//   Domingo        inhábil (ni llamadas ni citas)
//
// Formato de HORARIO_SEMANAL: 7 entradas separadas por coma, DOMINGO primero
// (mismo orden que Date.getDay(): 0=dom … 6=sáb). Cada entrada es "open-close"
// en horas enteras de 24 h (close exclusivo), o "-" para día inhábil. Ej.:
//   HORARIO_SEMANAL=-,10-20,10-20,10-20,10-20,10-20,8-12

import { config } from '../config';

const TZ = 'America/Mexico_City';

export interface DayWindow {
  open: number;  // hora de inicio (inclusive), 0–23
  close: number; // hora de cierre (exclusive), 1–24
}

function parseHorario(raw: string): ReadonlyArray<DayWindow | null> {
  const entradas = raw.split(',').map((e) => e.trim());
  if (entradas.length !== 7) {
    throw new Error(
      `HORARIO_SEMANAL inválido: se esperan 7 entradas separadas por coma (domingo primero), llegaron ${entradas.length}: "${raw}"`,
    );
  }

  return entradas.map((entrada, i) => {
    if (entrada === '-' || entrada === '') return null; // día inhábil

    const match = /^(\d{1,2})-(\d{1,2})$/.exec(entrada);
    if (!match) {
      throw new Error(
        `HORARIO_SEMANAL inválido en el día ${i} (0=dom…6=sáb): "${entrada}" — formato esperado "open-close" (ej. "10-20") o "-"`,
      );
    }
    const open = parseInt(match[1] as string, 10);
    const close = parseInt(match[2] as string, 10);
    if (open < 0 || close > 24 || open >= close) {
      throw new Error(
        `HORARIO_SEMANAL inválido en el día ${i}: "${entrada}" — se requiere 0 <= open < close <= 24`,
      );
    }
    return { open, close };
  });
}

// Cache del parse — la env no cambia en vida del proceso.
let tabla: ReadonlyArray<DayWindow | null> | undefined;

/** Ventana del día de la semana (0=dom…6=sáb), o null si inhábil. */
export function getWindowForDow(dow: number): DayWindow | null {
  tabla ??= parseHorario(config.HORARIO_SEMANAL);
  if (dow < 0 || dow > 6) return null;
  return tabla[dow] ?? null;
}

const DOW_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Ventana para una fecha ISO (YYYY-MM-DD) evaluada en America/Mexico_City,
 * o null si ese día es inhábil.
 */
export function getWindowForDayIso(dayIso: string): DayWindow | null {
  // Mediodía UTC para evitar saltos de día al convertir a MX.
  const probe = new Date(`${dayIso}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(probe);
  return getWindowForDow(DOW_MAP[weekday] ?? -1);
}
