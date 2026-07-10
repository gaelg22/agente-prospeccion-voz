import { describe, it, expect, vi } from 'vitest';

// assistant.config lee config al importarse — mock necesario (config.ts hace
// process.exit() si faltan envs)
vi.mock('../../../config', () => ({
  config: {
    PUBLIC_URL: 'https://agente-test.onrender.com',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
    AGENTE_NOMBRE: 'Sofía',
    EMPRESA_NOMBRE: 'Seguros Test S.A.',
    TELEFONO_OFICIAL: '55 1234 5678',
    VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
  },
}));

import { mapearDesenlace } from '../call-outcome.handler';
import { DESENLACES_LLAMADA } from '../assistant.config';

describe('mapearDesenlace — desenlace positivo', () => {
  it('acepto → acepto, sin reintento', () => {
    const r = mapearDesenlace('acepto', 1);
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

  it('interesado_sin_espacio → interesado_sin_espacio, sin reintento', () => {
    const r = mapearDesenlace('interesado_sin_espacio', 1);
    expect(r.nuevoStatus).toBe('interesado_sin_espacio');
    expect(r.debeReintentar).toBe(false);
  });
});

describe('mapearDesenlace — casos operativos (reintento 1 vez)', () => {
  it('buzon (intento 1) → listo_llamar + debeReintentar', () => {
    const r = mapearDesenlace('buzon', 1);
    expect(r.nuevoStatus).toBe('listo_llamar');
    expect(r.debeReintentar).toBe(true);
  });

  it('buzon (intento 2) → no_contactable, sin reintento', () => {
    const r = mapearDesenlace('buzon', 2);
    expect(r.nuevoStatus).toBe('no_contactable');
    expect(r.debeReintentar).toBe(false);
  });

  it('numero_equivocado (intento 1) → listo_llamar + debeReintentar', () => {
    const r = mapearDesenlace('numero_equivocado', 1);
    expect(r.nuevoStatus).toBe('listo_llamar');
    expect(r.debeReintentar).toBe(true);
  });

  it('numero_equivocado (intento 2) → no_contactable, sin reintento', () => {
    const r = mapearDesenlace('numero_equivocado', 2);
    expect(r.nuevoStatus).toBe('no_contactable');
    expect(r.debeReintentar).toBe(false);
  });

  it('buzon (intento 0) → listo_llamar + debeReintentar', () => {
    const r = mapearDesenlace('buzon', 0);
    expect(r.nuevoStatus).toBe('listo_llamar');
    expect(r.debeReintentar).toBe(true);
  });

  it('error_tecnico (intento 1) → listo_llamar + debeReintentar (el lead se recupera solo)', () => {
    const r = mapearDesenlace('error_tecnico', 1);
    expect(r.nuevoStatus).toBe('listo_llamar');
    expect(r.debeReintentar).toBe(true);
    expect(r.nota).toContain('Falla técnica');
  });

  it('error_tecnico (intento 2) → no_contactable, sin reintento', () => {
    const r = mapearDesenlace('error_tecnico', 2);
    expect(r.nuevoStatus).toBe('no_contactable');
    expect(r.debeReintentar).toBe(false);
  });
});

describe('mapearDesenlace — cobertura exhaustiva', () => {
  it('mapea TODOS los desenlaces de DESENLACES_LLAMADA (fuente única)', () => {
    expect(DESENLACES_LLAMADA).toHaveLength(7);
    for (const desenlace of DESENLACES_LLAMADA) {
      const r = mapearDesenlace(desenlace, 1);
      expect(r).toHaveProperty('nuevoStatus');
      expect(r).toHaveProperty('nota');
      expect(r).toHaveProperty('debeReintentar');
      expect(typeof r.nota).toBe('string');
      expect(r.nota.length).toBeGreaterThan(0);
    }
  });
});
