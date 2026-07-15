import { describe, it, expect, vi } from 'vitest';

// ─── Mock de config: env del asesor (5 municipios cortos + estado Jalisco) ────
// La env queda EXACTA con los nombres cortos; el match por contención de token
// captura los nombres oficiales largos que entrega DENUE.

vi.mock('../../config', () => ({
  config: {
    ASESOR_ESTADO: 'Jalisco',
    ZONA_PRESENCIAL_MUNICIPIOS: 'Guadalajara,Zapopan,Tlaquepaque,Tonalá,Tlajomulco',
  },
}));

import { esZonaPresencial, normalizar } from '../zona-presencial';

describe('esZonaPresencial — municipio (contención de token) AND estado == Jalisco', () => {
  it('DENUE "San Pedro Tlaquepaque"/Jalisco → presencial (nombre oficial largo)', () => {
    expect(esZonaPresencial('San Pedro Tlaquepaque', 'Jalisco')).toBe(true);
  });

  it('DENUE "Tlajomulco de Zúñiga"/Jalisco → presencial (nombre oficial largo)', () => {
    expect(esZonaPresencial('Tlajomulco de Zúñiga', 'Jalisco')).toBe(true);
  });

  it('"Tonalá"/Jalisco → presencial', () => {
    expect(esZonaPresencial('Tonalá', 'Jalisco')).toBe(true);
  });

  it('Guadalajara y Zapopan / Jalisco → presencial', () => {
    expect(esZonaPresencial('Guadalajara', 'Jalisco')).toBe(true);
    expect(esZonaPresencial('Zapopan', 'Jalisco')).toBe(true);
  });

  it('"Tonalá"/Chiapas → NO presencial (filtro de estado: Tonalá también en Chiapas)', () => {
    expect(esZonaPresencial('Tonalá', 'Chiapas')).toBe(false);
  });

  it('"Monterrey"/Nuevo León → NO presencial (virtual)', () => {
    expect(esZonaPresencial('Monterrey', 'Nuevo León')).toBe(false);
  });

  it('municipio vacío o nulo → NO presencial (fallback seguro → virtual)', () => {
    expect(esZonaPresencial('', 'Jalisco')).toBe(false);
    expect(esZonaPresencial(null, 'Jalisco')).toBe(false);
    expect(esZonaPresencial(undefined, 'Jalisco')).toBe(false);
  });

  it('estado vacío o nulo → NO presencial', () => {
    expect(esZonaPresencial('Zapopan', '')).toBe(false);
    expect(esZonaPresencial('Zapopan', null)).toBe(false);
  });

  it('normaliza acentos y mayúsculas en ambos lados (municipio y estado)', () => {
    expect(esZonaPresencial('ZAPOPAN', 'JALISCO')).toBe(true);
    expect(esZonaPresencial('tlajomulco de zuniga', 'jalisco')).toBe(true);
  });

  it('match por PALABRA COMPLETA: "Tlaquepaquito" no cuenta como Tlaquepaque', () => {
    expect(esZonaPresencial('Tlaquepaquito', 'Jalisco')).toBe(false);
  });
});

describe('normalizar', () => {
  it('quita acentos, pasa a minúsculas y colapsa espacios', () => {
    expect(normalizar('  Tlajomulco   de  Zúñiga ')).toBe('tlajomulco de zuniga');
    expect(normalizar('Tonalá')).toBe('tonala');
  });
});
