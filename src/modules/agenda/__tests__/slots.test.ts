import { describe, it, expect, vi } from 'vitest';

// slots → calendar.client → config.ts (process.exit si faltan envs). Mock mínimo.
vi.mock('../../../config', () => ({ config: { GOOGLE_MEET_ENABLED: false } }));

import { getAvailableSlots } from '../slots';
import type { CalendarClient } from '../calendar.client';

// CalendarClient falso sin agenda ocupada: aísla la lógica de duración/ventana.
const clienteLibre = {
  getBusySlots: async () => [],
} as unknown as CalendarClient;

describe('getAvailableSlots — duración por modalidad', () => {
  it('virtual (1 h): starts 09:00–20:00, cada uno termina 1 h después', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre, 1);

    expect(slots[0]?.startIso).toBe('2026-08-03T09:00:00');
    expect(slots[0]?.endIso).toBe('2026-08-03T10:00:00');
    // Último slot arranca 20:00 y termina 21:00 (CLOSE_HOUR).
    expect(slots.at(-1)?.startIso).toBe('2026-08-03T20:00:00');
    expect(slots.at(-1)?.endIso).toBe('2026-08-03T21:00:00');
    expect(slots).toHaveLength(12); // 09..20
  });

  it('presencial (2 h): starts 09:00–19:00, cada uno termina 2 h después', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre, 2);

    expect(slots[0]?.startIso).toBe('2026-08-03T09:00:00');
    expect(slots[0]?.endIso).toBe('2026-08-03T11:00:00');
    // Último slot arranca 19:00 y termina 21:00 — no se ofrece 20:00 (terminaría 22:00).
    expect(slots.at(-1)?.startIso).toBe('2026-08-03T19:00:00');
    expect(slots.at(-1)?.endIso).toBe('2026-08-03T21:00:00');
    expect(slots).toHaveLength(11); // 09..19
  });

  it('default sin durationHours es 1 h (compat)', async () => {
    const slots = await getAvailableSlots('2026-08-03', clienteLibre);
    expect(slots).toHaveLength(12);
  });
});
