import { describe, it, expect } from 'vitest';
import { formatFechaHoraMexico, fechaMexicoISO } from '../fecha-mexico';

// México es UTC-6 todo el año (sin horario de verano desde 2022), así que
// cualquier instante entre 00:00 y 06:00 UTC cae en el día ANTERIOR en México.
// Ese es justo el escenario del bug: el server en UTC ya está en el día siguiente.

describe('fechaMexicoISO — fecha calendario en zona de México', () => {
  it('02:00 UTC del 14 jul = 20:00 del 13 jul en México (mismo día, NO el siguiente)', () => {
    const instante = new Date('2026-07-14T02:00:00Z');
    // UTC daría 2026-07-14; México debe dar 2026-07-13.
    expect(instante.toISOString().slice(0, 10)).toBe('2026-07-14'); // lo que daría el bug
    expect(fechaMexicoISO(instante, 0)).toBe('2026-07-13');
  });

  it('1 PM de México = mismo día', () => {
    // 13:00 hora de México = 19:00 UTC del mismo día.
    expect(fechaMexicoISO(new Date('2026-07-13T19:00:00Z'), 0)).toBe('2026-07-13');
  });

  it('aplica el offset de días sobre la fecha de México, no sobre la de UTC', () => {
    const instante = new Date('2026-07-14T02:00:00Z'); // 13 jul 20:00 México
    expect(fechaMexicoISO(instante, 1)).toBe('2026-07-14');
    expect(fechaMexicoISO(instante, 2)).toBe('2026-07-15');
  });

  it('cruza fin de mes correctamente en zona de México', () => {
    // 01:00 UTC del 1 ago = 31 jul 19:00 México.
    expect(fechaMexicoISO(new Date('2026-08-01T01:00:00Z'), 0)).toBe('2026-07-31');
    expect(fechaMexicoISO(new Date('2026-08-01T01:00:00Z'), 1)).toBe('2026-08-01');
  });
});

describe('formatFechaHoraMexico — string para el prompt', () => {
  it('formatea la fecha local mexicana, no la de UTC', () => {
    // 02:00 UTC del 14 jul = 13 jul (lunes) 20:00 en México.
    const s = formatFechaHoraMexico(new Date('2026-07-14T02:00:00Z'));
    expect(s).toContain('13');
    expect(s).toContain('julio');
    expect(s).toContain('lunes');
    expect(s).not.toContain('14 de julio');
    expect(s).not.toContain('martes');
  });

  it('incluye la hora local de México', () => {
    // 19:00 UTC = 13:00 (1 PM) México.
    const s = formatFechaHoraMexico(new Date('2026-07-13T19:00:00Z'));
    expect(s).toContain('13 de julio');
    expect(s.toLowerCase()).toContain('1:00');
  });
});
