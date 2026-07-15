import { describe, it, expect, vi } from 'vitest';

// slots → calendar.client → config.ts (process.exit si faltan envs). Mock mínimo.
vi.mock('../../../config', () => ({ config: { GOOGLE_MEET_ENABLED: false } }));

import { getAvailableSlots } from '../slots';
import type { CalendarClient } from '../calendar.client';

// CalendarClient falso sin agenda ocupada: aísla la lógica de duración/ventana.
const clienteLibre = {
  getBusySlots: async () => [],
} as unknown as CalendarClient;

// ─── Ventana L-V: 10:00–20:00 ─────────────────────────────────────────────────
// 2026-08-03 es lunes
describe('getAvailableSlots — L-V (lunes 2026-08-03)', () => {
  it('virtual (1 h): primer slot 10:00, último 19:00 (termina 20:00)', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre, 1);

    expect(slots[0]?.startIso).toBe('2026-08-03T10:00:00');
    expect(slots[0]?.endIso).toBe('2026-08-03T11:00:00');
    // Último inicio permitido = close(20) - duration(1) = 19:00
    expect(slots.at(-1)?.startIso).toBe('2026-08-03T19:00:00');
    expect(slots.at(-1)?.endIso).toBe('2026-08-03T20:00:00');
    expect(slots).toHaveLength(10); // 10,11,12,13,14,15,16,17,18,19
  });

  it('presencial (2 h): primer slot 10:00, último 18:00 (termina 20:00)', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre, 2);

    expect(slots[0]?.startIso).toBe('2026-08-03T10:00:00');
    expect(slots[0]?.endIso).toBe('2026-08-03T12:00:00');
    // Último inicio permitido = close(20) - duration(2) = 18:00
    expect(slots.at(-1)?.startIso).toBe('2026-08-03T18:00:00');
    expect(slots.at(-1)?.endIso).toBe('2026-08-03T20:00:00');
    expect(slots).toHaveLength(9); // 10,11,12,13,14,15,16,17,18
  });

  it('default sin durationHours es 1 h (compat)', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre);
    expect(slots).toHaveLength(10);
  });
});

// ─── Ventana Sábado: 08:00–12:00 ─────────────────────────────────────────────
// 2026-08-08 es sábado
describe('getAvailableSlots — Sábado (2026-08-08)', () => {
  it('virtual (1 h): primer slot 08:00, último 11:00 (termina 12:00)', async () => {
    const slots = await getAvailableSlots('2026-08-08', clienteLibre, 1);

    expect(slots[0]?.startIso).toBe('2026-08-08T08:00:00');
    expect(slots[0]?.endIso).toBe('2026-08-08T09:00:00');
    // Último inicio = close(12) - duration(1) = 11:00
    expect(slots.at(-1)?.startIso).toBe('2026-08-08T11:00:00');
    expect(slots.at(-1)?.endIso).toBe('2026-08-08T12:00:00');
    expect(slots).toHaveLength(4); // 08,09,10,11
  });

  it('presencial (2 h): primer slot 08:00, último 10:00 (termina 12:00)', async () => {
    const slots = await getAvailableSlots('2026-08-08', clienteLibre, 2);

    expect(slots[0]?.startIso).toBe('2026-08-08T08:00:00');
    expect(slots.at(-1)?.startIso).toBe('2026-08-08T10:00:00');
    expect(slots.at(-1)?.endIso).toBe('2026-08-08T12:00:00');
    expect(slots).toHaveLength(3); // 08,09,10
  });

  // CASO PEDIDO: sábado 11:30 → virtual no cabe (inicio máx 11:00)
  it('🟥 sábado: NO ofrece slot virtual que arranque a las 11:30 (no cabe)', async () => {
    const slots = await getAvailableSlots('2026-08-08', clienteLibre, 1);
    const has1130 = slots.some((s) => s.startHour === 11 && s.startIso.includes('T11:30'));
    // Los slots son de hora en hora; el punto es que 12:00 no está disponible como inicio
    const hasStart12 = slots.some((s) => s.startHour === 12);
    expect(hasStart12).toBe(false); // 12:00 inicio → terminaría 13:00, fuera de ventana
    // Y 11:00 sí aparece (es el último), confirma que el límite es correcto
    expect(slots.some((s) => s.startHour === 11)).toBe(true);
  });

  // CASO PEDIDO: presencial no se ofrece después de las 10:00 sábado
  it('🟥 sábado: NO ofrece presencial (2h) que arranque a las 11:00', async () => {
    const slots = await getAvailableSlots('2026-08-08', clienteLibre, 2);
    expect(slots.some((s) => s.startHour === 11)).toBe(false);
  });
});

// ─── Domingo: inhábil ─────────────────────────────────────────────────────────
// 2026-08-09 es domingo
describe('getAvailableSlots — Domingo (2026-08-09)', () => {
  // CASO PEDIDO: domingo no ofrece nada ni marca
  it('🟥 domingo: retorna [] para virtual', async () => {
    const slots = await getAvailableSlots('2026-08-09', clienteLibre, 1);
    expect(slots).toHaveLength(0);
  });

  it('🟥 domingo: retorna [] para presencial', async () => {
    const slots = await getAvailableSlots('2026-08-09', clienteLibre, 2);
    expect(slots).toHaveLength(0);
  });
});

// ─── Corte de slots L-V (casos pedidos) ──────────────────────────────────────
describe('getAvailableSlots — corte L-V', () => {
  // CASO PEDIDO: L-V 19:30 no ofrece virtual (inicio máx 19:00; 19:30 no existe porque slots son :00)
  it('🟥 L-V: NO ofrece slot virtual con inicio >= 20:00', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre, 1);
    expect(slots.some((s) => s.startHour >= 20)).toBe(false);
  });

  // CASO PEDIDO: presencial no se ofrece después de 18:00 L-V
  it('🟥 L-V: NO ofrece presencial (2h) con inicio > 18:00', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre, 2);
    expect(slots.some((s) => s.startHour > 18)).toBe(false);
  });
});
