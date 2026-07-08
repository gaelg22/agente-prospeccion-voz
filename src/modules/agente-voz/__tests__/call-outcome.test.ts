import { describe, it, expect } from 'vitest';
import { mapearDesenlace } from '../call-outcome.handler';

describe('mapearDesenlace — desenlaces positivos', () => {
  it('interesado → acepto, sin reintento', () => {
    const r = mapearDesenlace('interesado', 1);
    expect(r.nuevoStatus).toBe('acepto');
    expect(r.debeReintentar).toBe(false);
  });
});

describe('mapearDesenlace — rechazos terminales', () => {
  it('no_interesado → no_interesado, sin reintento', () => {
    const r = mapearDesenlace('no_interesado', 1);
    expect(r.nuevoStatus).toBe('no_interesado');
    expect(r.debeReintentar).toBe(false);
  });

  it('no_contactar → no_contactar, sin reintento', () => {
    const r = mapearDesenlace('no_contactar', 1);
    expect(r.nuevoStatus).toBe('no_contactar');
    expect(r.debeReintentar).toBe(false);
  });

  it('numero_incorrecto → no_contactable, sin reintento', () => {
    const r = mapearDesenlace('numero_incorrecto', 0);
    expect(r.nuevoStatus).toBe('no_contactable');
    expect(r.debeReintentar).toBe(false);
  });

  it('interesado_sin_espacio → interesado_sin_espacio, sin reintento', () => {
    const r = mapearDesenlace('interesado_sin_espacio', 1);
    expect(r.nuevoStatus).toBe('interesado_sin_espacio');
    expect(r.debeReintentar).toBe(false);
  });
});

describe('mapearDesenlace — sin respuesta (reintento 1 vez)', () => {
  it('no_contesto (intentos=1) → listo_llamar + debeReintentar', () => {
    const r = mapearDesenlace('no_contesto', 1);
    expect(r.nuevoStatus).toBe('listo_llamar');
    expect(r.debeReintentar).toBe(true);
  });

  it('buzon (intentos=1) → listo_llamar + debeReintentar', () => {
    const r = mapearDesenlace('buzon', 1);
    expect(r.nuevoStatus).toBe('listo_llamar');
    expect(r.debeReintentar).toBe(true);
  });

  it('no_contesto (intentos=2) → no_contactable, sin reintento', () => {
    const r = mapearDesenlace('no_contesto', 2);
    expect(r.nuevoStatus).toBe('no_contactable');
    expect(r.debeReintentar).toBe(false);
  });

  it('buzon (intentos=2) → no_contactable, sin reintento', () => {
    const r = mapearDesenlace('buzon', 2);
    expect(r.nuevoStatus).toBe('no_contactable');
    expect(r.debeReintentar).toBe(false);
  });

  it('no_contesto (intentos=0) → listo_llamar + debeReintentar', () => {
    const r = mapearDesenlace('no_contesto', 0);
    expect(r.nuevoStatus).toBe('listo_llamar');
    expect(r.debeReintentar).toBe(true);
  });
});

describe('mapearDesenlace — forma de la respuesta', () => {
  it('siempre devuelve nuevoStatus, nota y debeReintentar', () => {
    const r = mapearDesenlace('interesado', 1);
    expect(r).toHaveProperty('nuevoStatus');
    expect(r).toHaveProperty('nota');
    expect(r).toHaveProperty('debeReintentar');
    expect(typeof r.nota).toBe('string');
    expect(r.nota.length).toBeGreaterThan(0);
  });
});
