import { describe, it, expect, vi } from 'vitest';

// calling-window → lib/horario → config.ts (process.exit si faltan envs).
// Mock con el horario default: L-V 10-20, sáb 8-12, dom inhábil.
vi.mock('../../config', () => ({
  config: { HORARIO_SEMANAL: '-,10-20,10-20,10-20,10-20,10-20,8-12' },
}));

import { isInCallingWindow, isMorningSlot, nextDayOppositeSlot } from '../calling-window';

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Construye un Date UTC que equivale a "dayOfWeek HH:MM en MX (CST = UTC-6)".
// Usa como ancla la semana del 2025-07-07 (lun) … 2025-07-13 (dom).
// dayOfWeek: 0=dom,1=lun,…,6=sáb
function mxTime(dayOfWeek: number, hour: number, minute = 0): Date {
  // 2025-07-07 es lunes → offset 0=dom usa -6, 1=lun usa 0, etc.
  const monOffset = 0; // lunes es el índice 1
  // Día base: lunes 2025-07-07 00:00 UTC
  const baseMon = Date.UTC(2025, 6, 7); // 7 jul 2025 lunes
  const dayDelta = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // dom queda el 13 jul
  const dayBase = baseMon + dayDelta * 86_400_000;
  // CST = UTC-6, así que "hour MX" = (hour+6) UTC
  return new Date(dayBase + (hour + 6) * 3_600_000 + minute * 60_000);
}

// Día específico ISO en MX (CST) con hora dada
function mxTimeOnDate(isoDate: string, hour: number, minute = 0): Date {
  return new Date(
    Date.parse(`${isoDate}T${String(hour + 6).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`)
  );
}

// ─── isInCallingWindow ────────────────────────────────────────────────────────
describe('isInCallingWindow', () => {
  // L-V: ventana 10:00–19:59
  it('L-V: true a las 10:00 MX (apertura)', () => {
    expect(isInCallingWindow(mxTime(1, 10, 0))).toBe(true);
  });

  it('L-V: true a las 15:00 MX', () => {
    expect(isInCallingWindow(mxTime(3, 15, 0))).toBe(true);
  });

  it('L-V: true a las 19:59 MX (último minuto)', () => {
    expect(isInCallingWindow(mxTime(2, 19, 59))).toBe(true);
  });

  it('L-V: false a las 20:00 MX (cierre)', () => {
    expect(isInCallingWindow(mxTime(4, 20, 0))).toBe(false);
  });

  it('L-V: false a las 09:59 MX (antes de apertura)', () => {
    expect(isInCallingWindow(mxTime(5, 9, 59))).toBe(false);
  });

  // Sábado: ventana 08:00–11:59
  it('Sábado: true a las 08:00 MX (apertura)', () => {
    expect(isInCallingWindow(mxTime(6, 8, 0))).toBe(true);
  });

  it('Sábado: true a las 11:30 MX', () => {
    expect(isInCallingWindow(mxTime(6, 11, 30))).toBe(true);
  });

  it('Sábado: false a las 12:00 MX (cierre)', () => {
    expect(isInCallingWindow(mxTime(6, 12, 0))).toBe(false);
  });

  it('Sábado: false a las 07:59 MX (antes apertura)', () => {
    expect(isInCallingWindow(mxTime(6, 7, 59))).toBe(false);
  });

  // Domingo: inhábil — nunca marca
  it('Domingo: false a las 10:00 MX', () => {
    expect(isInCallingWindow(mxTime(0, 10, 0))).toBe(false);
  });

  it('Domingo: false a las 15:00 MX', () => {
    expect(isInCallingWindow(mxTime(0, 15, 0))).toBe(false);
  });
});

// ─── isMorningSlot ────────────────────────────────────────────────────────────
describe('isMorningSlot', () => {
  // L-V midpoint = floor((10+20)/2) = 15
  it('L-V: true a las 10:00 (apertura, tramo mañana)', () => {
    expect(isMorningSlot(mxTime(1, 10, 0))).toBe(true);
  });

  it('L-V: true a las 14:59', () => {
    expect(isMorningSlot(mxTime(1, 14, 59))).toBe(true);
  });

  it('L-V: false a las 15:00 (tarde)', () => {
    expect(isMorningSlot(mxTime(1, 15, 0))).toBe(false);
  });

  it('L-V: false a las 19:00 (tarde)', () => {
    expect(isMorningSlot(mxTime(1, 19, 0))).toBe(false);
  });

  // Domingo: inhábil → false
  it('Domingo: false siempre', () => {
    expect(isMorningSlot(mxTime(0, 10, 0))).toBe(false);
  });
});

// ─── nextDayOppositeSlot ──────────────────────────────────────────────────────
describe('nextDayOppositeSlot', () => {
  it('siempre es en el futuro respecto al input', () => {
    const now = mxTime(1, 10, 0);
    const result = nextDayOppositeSlot(now);
    expect(result.getTime()).toBeGreaterThan(now.getTime());
  });

  it('llamada de mañana L-V → slot tarde del siguiente día hábil', () => {
    const morningCall = mxTime(1 /* lun */, 11, 0); // lunes 11:00 MX
    const result = nextDayOppositeSlot(morningCall);
    const resultHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric',
      hour12: false,
    }).format(result);
    // midpoint L-V = 15
    expect(parseInt(resultHour, 10)).toBe(15);
  });

  it('llamada de tarde L-V → apertura (10:00) del siguiente día hábil', () => {
    const afternoonCall = mxTime(3 /* mié */, 17, 0);
    const result = nextDayOppositeSlot(afternoonCall);
    const resultHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric',
      hour12: false,
    }).format(result);
    expect(parseInt(resultHour, 10)).toBe(10);
  });

  it('llamada del domingo → siguiente día hábil (lunes)', () => {
    const sundayCall = mxTime(0 /* dom */, 14, 0);
    const result = nextDayOppositeSlot(sundayCall);
    const resultWeekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      weekday: 'short',
    }).format(result);
    expect(resultWeekday).toBe('Mon');
  });
});
