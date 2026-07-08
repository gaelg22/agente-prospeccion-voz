import { describe, it, expect, vi } from 'vitest';

// ─── Mock de config — assistant.config lee estas envs al importarse ──────────

vi.mock('../../../config', () => ({
  config: {
    PUBLIC_URL: 'https://agente-test.onrender.com',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
    AGENTE_NOMBRE: 'Laia',
    EMPRESA_NOMBRE: 'Seguros Test S.A.',
    TELEFONO_OFICIAL: '55 1234 5678',
  },
}));

import { assistantTools, systemPrompt, DESENLACES_LLAMADA } from '../assistant.config';

// ─── Tools ────────────────────────────────────────────────────────────────────

describe('assistantTools — estructura y server target', () => {
  it('define exactamente las 4 tools de la especificación', () => {
    expect(assistantTools.map((t) => t.function.name)).toEqual([
      'verificar_disponibilidad',
      'agendar_cita',
      'registrar_resultado',
      'marcar_no_contactar',
    ]);
  });

  it('todas las tools apuntan a PUBLIC_URL + /webhooks/vapi', () => {
    for (const tool of assistantTools) {
      expect(tool.server.url).toBe('https://agente-test.onrender.com/webhooks/vapi');
    }
  });

  it('todas las tools llevan el secret del webhook', () => {
    for (const tool of assistantTools) {
      expect(tool.server.secret).toBe('secreto-de-prueba');
    }
  });

  it('agendar_cita requiere fecha y hora', () => {
    const agendar = assistantTools.find((t) => t.function.name === 'agendar_cita');
    expect(agendar?.function.parameters.required).toEqual(['fecha', 'hora']);
  });

  it('el enum de registrar_resultado tiene exactamente los 6 desenlaces', () => {
    const registrar = assistantTools.find((t) => t.function.name === 'registrar_resultado');
    const desenlaces = registrar?.function.parameters.properties['desenlace']?.enum;

    expect(desenlaces).toEqual([
      'acepto',
      'no_interesado',
      'interesado_sin_espacio',
      'no_contactar',
      'buzon',
      'numero_equivocado',
    ]);
    expect(desenlaces).toHaveLength(6);
    expect(DESENLACES_LLAMADA).toHaveLength(6);
  });

  it('tolera PUBLIC_URL con slash final sin duplicar la diagonal', async () => {
    vi.resetModules();
    vi.doMock('../../../config', () => ({
      config: {
        PUBLIC_URL: 'https://otro-servicio.onrender.com/',
        VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
        AGENTE_NOMBRE: 'Laia',
        EMPRESA_NOMBRE: 'Seguros Test S.A.',
        TELEFONO_OFICIAL: '55 1234 5678',
      },
    }));

    const mod = await import('../assistant.config');
    expect(mod.assistantTools[0]?.server.url).toBe(
      'https://otro-servicio.onrender.com/webhooks/vapi',
    );

    vi.doUnmock('../../../config');
    vi.resetModules();
  });
});

// ─── System prompt ────────────────────────────────────────────────────────────

describe('systemPrompt — carga y sustitución de placeholders', () => {
  it('no contiene ningún placeholder [EN CORCHETES] sin sustituir', () => {
    expect(systemPrompt).not.toMatch(/\[[A-ZÁÉÍÓÚÜÑ_/ ]+\]/);
  });

  it('sustituyó los tres placeholders con los valores de config', () => {
    expect(systemPrompt).toContain('Laia');
    expect(systemPrompt).toContain('Seguros Test S.A.');
    expect(systemPrompt).toContain('55 1234 5678');
  });

  it('no incluye el encabezado instructivo del documento', () => {
    expect(systemPrompt.startsWith('## 1. IDENTIDAD Y ROL')).toBe(true);
    expect(systemPrompt).not.toContain('Pega el bloque');
  });

  it('conserva las variables {{...}} de Vapi (esas las llena Vapi, no el backend)', () => {
    expect(systemPrompt).toContain('{{prospecto_nombre}}');
    expect(systemPrompt).toContain('{{now}}');
  });
});
