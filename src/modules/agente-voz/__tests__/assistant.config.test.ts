import { describe, it, expect, vi } from 'vitest';

// ─── Mock de config — assistant.config lee estas envs al importarse ──────────

vi.mock('../../../config', () => ({
  config: {
    PUBLIC_URL: 'https://agente-test.onrender.com',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
    AGENTE_NOMBRE: 'Laia',
    EMPRESA_NOMBRE: 'Seguros Test S.A.',
    TELEFONO_OFICIAL: '55 1234 5678',
    VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
    VAPI_VOICE_ID: 'voz-de-prueba',
  },
}));

import {
  assistantTools,
  systemPrompt,
  DESENLACES_LLAMADA,
  buildAssistant,
} from '../assistant.config';

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

// ─── Assistant transient ──────────────────────────────────────────────────────

describe('buildAssistant — assistant transient completo', () => {
  it('lleva el system prompt como primer mensaje del modelo', () => {
    const assistant = buildAssistant();
    expect(assistant.model.messages).toEqual([{ role: 'system', content: systemPrompt }]);
  });

  it('lleva las 4 tools de la especificación', () => {
    const assistant = buildAssistant();
    expect(assistant.model.tools).toBe(assistantTools);
    expect(assistant.model.tools.map((t) => t.function.name)).toEqual([
      'verificar_disponibilidad',
      'agendar_cita',
      'registrar_resultado',
      'marcar_no_contactar',
    ]);
  });

  it('usa provider anthropic con el modelo de config', () => {
    const assistant = buildAssistant();
    expect(assistant.model.provider).toBe('anthropic');
    expect(assistant.model.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('apunta el server del assistant al webhook (eventos de llamada)', () => {
    const assistant = buildAssistant();
    expect(assistant.server).toEqual({
      url: 'https://agente-test.onrender.com/webhooks/vapi',
      secret: 'secreto-de-prueba',
    });
  });

  it('configura el transcriber en español (Deepgram)', () => {
    const assistant = buildAssistant();
    expect(assistant.transcriber).toEqual({
      provider: 'deepgram',
      model: 'nova-2',
      language: 'es',
    });
  });

  it('configura la voz ElevenLabs multilingüe con el voiceId de config', () => {
    const assistant = buildAssistant();
    expect(assistant.voice).toEqual({
      provider: '11labs',
      voiceId: 'voz-de-prueba',
      model: 'eleven_multilingual_v2',
    });
  });

  it('lleva firstMessage en español con la identidad y la variable del prospecto', () => {
    const assistant = buildAssistant();
    expect(assistant.firstMessage).toContain('Laia');
    expect(assistant.firstMessage).toContain('Seguros Test S.A.');
    expect(assistant.firstMessage).toContain('{{prospecto_nombre}}');
  });
});
