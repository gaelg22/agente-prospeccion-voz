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

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;

/**
 * Frase en español del horario semanal para el system prompt, generada de la
 * MISMA tabla que gobierna llamadas y slots — si cambia HORARIO_SEMANAL,
 * cambia lo que Sofía recita. Agrupa días consecutivos con la misma ventana,
 * lunes primero y los inhábiles al final tras punto y coma.
 * Default: "lunes–viernes 10:00–20:00, sábado 08:00–12:00; domingo inhábil".
 */
export function describirHorarioSemanal(): string {
  tabla ??= parseHorario(config.HORARIO_SEMANAL);

  const clave = (w: DayWindow | null): string => (w ? `${w.open}-${w.close}` : '-');
  const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;

  interface Grupo { desde: number; hasta: number; window: DayWindow | null }
  const grupos: Grupo[] = [];
  for (const dow of [1, 2, 3, 4, 5, 6, 0]) { // lunes … sábado, domingo al final
    const window = tabla[dow] ?? null;
    const previo = grupos[grupos.length - 1];
    if (previo && clave(previo.window) === clave(window)) {
      previo.hasta = dow;
    } else {
      grupos.push({ desde: dow, hasta: dow, window });
    }
  }

  const etiqueta = (g: Grupo): string =>
    g.desde === g.hasta ? DIAS_ES[g.desde] as string : `${DIAS_ES[g.desde]}–${DIAS_ES[g.hasta]}`;

  const habiles = grupos
    .filter((g): g is Grupo & { window: DayWindow } => g.window !== null)
    .map((g) => `${etiqueta(g)} ${hh(g.window.open)}–${hh(g.window.close)}`);
  const inhabiles = grupos.filter((g) => g.window === null).map((g) => `${etiqueta(g)} inhábil`);

  if (habiles.length === 0) return inhabiles.join(', ');
  if (inhabiles.length === 0) return habiles.join(', ');
  return `${habiles.join(', ')}; ${inhabiles.join(', ')}`;
}

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
