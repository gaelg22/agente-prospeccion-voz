import { describe, it, expect, vi, afterEach } from 'vitest';

// Cada test carga lib/horario con una env distinta: resetModules limpia el
// cache del parse (module-level) y doMock inyecta el config deseado.
afterEach(() => {
  vi.doUnmock('../../config');
  vi.resetModules();
});

async function cargarHorario(horarioSemanal: string) {
  vi.resetModules();
  vi.doMock('../../config', () => ({ config: { HORARIO_SEMANAL: horarioSemanal } }));
  return import('../horario');
}

const DEFAULT = '-,10-20,10-20,10-20,10-20,10-20,8-12';

describe('getWindowForDow — tabla default', () => {
  it('domingo (0) es inhábil, L-V 10-20, sábado 8-12', async () => {
    const { getWindowForDow } = await cargarHorario(DEFAULT);

    expect(getWindowForDow(0)).toBeNull();
    for (const dow of [1, 2, 3, 4, 5]) {
      expect(getWindowForDow(dow)).toEqual({ open: 10, close: 20 });
    }
    expect(getWindowForDow(6)).toEqual({ open: 8, close: 12 });
  });

  it('dow fuera de rango → null', async () => {
    const { getWindowForDow } = await cargarHorario(DEFAULT);
    expect(getWindowForDow(-1)).toBeNull();
    expect(getWindowForDow(7)).toBeNull();
  });
});

describe('getWindowForDayIso — fecha ISO evaluada en MX', () => {
  it('2026-08-03 (lunes) → 10-20; 2026-08-08 (sábado) → 8-12; 2026-08-09 (domingo) → null', async () => {
    const { getWindowForDayIso } = await cargarHorario(DEFAULT);

    expect(getWindowForDayIso('2026-08-03')).toEqual({ open: 10, close: 20 });
    expect(getWindowForDayIso('2026-08-08')).toEqual({ open: 8, close: 12 });
    expect(getWindowForDayIso('2026-08-09')).toBeNull();
  });
});

describe('describirHorarioSemanal — frase para el system prompt', () => {
  it('default: agrupa L–V, sábado aparte y el inhábil al final tras punto y coma', async () => {
    const { describirHorarioSemanal } = await cargarHorario(DEFAULT);
    expect(describirHorarioSemanal()).toBe(
      'lunes–viernes 10:00–20:00, sábado 08:00–12:00; domingo inhábil',
    );
  });

  it('cambiar HORARIO_SEMANAL cambia la frase (domingo hábil, sábado inhábil)', async () => {
    const { describirHorarioSemanal } = await cargarHorario('9-13,11-19,11-19,11-19,11-19,11-19,-');
    expect(describirHorarioSemanal()).toBe(
      'lunes–viernes 11:00–19:00, domingo 09:00–13:00; sábado inhábil',
    );
  });

  it('días inhábiles consecutivos se agrupan (sábado–domingo)', async () => {
    const { describirHorarioSemanal } = await cargarHorario('-,9-17,9-17,9-17,9-17,9-17,-');
    expect(describirHorarioSemanal()).toBe('lunes–viernes 09:00–17:00; sábado–domingo inhábil');
  });
});

describe('HORARIO_SEMANAL configurable por env', () => {
  it('una tabla custom (domingo hábil, sábado inhábil) se respeta', async () => {
    const { getWindowForDow } = await cargarHorario('9-13,11-19,11-19,11-19,11-19,11-19,-');

    expect(getWindowForDow(0)).toEqual({ open: 9, close: 13 }); // domingo hábil
    expect(getWindowForDow(1)).toEqual({ open: 11, close: 19 });
    expect(getWindowForDow(6)).toBeNull(); // sábado inhábil
  });

  it('formato inválido lanza error claro (fail fast al primer uso)', async () => {
    const { getWindowForDow } = await cargarHorario('10-20'); // solo 1 entrada
    expect(() => getWindowForDow(1)).toThrow(/7 entradas/);

    const mod2 = await cargarHorario('-,10-20,10-20,10-20,10-20,veinte,8-12');
    expect(() => mod2.getWindowForDow(1)).toThrow(/formato esperado/);

    const mod3 = await cargarHorario('-,20-10,10-20,10-20,10-20,10-20,8-12'); // open >= close
    expect(() => mod3.getWindowForDow(1)).toThrow(/open < close/);
  });
});
