import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// ─── Mock de config — assistant.config lee estas envs al importarse ──────────
// AGENTE_NOMBRE usa un valor que no coincide con el default de config.ts:
// si alguien hardcodea el nombre en el prompt o el firstMessage, estos
// asserts fallan.

const mockConfig = vi.hoisted(() => ({
  PUBLIC_URL: 'https://agente-test.onrender.com',
  VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
  AGENTE_NOMBRE: 'Valentina de Prueba',
  EMPRESA_NOMBRE: 'Seguros Test S.A.',
  TELEFONO_OFICIAL: '55 1234 5678',
  VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
  VAPI_VOICE_ID: 'voz-de-prueba',
  VAPI_TRANSCRIBER_MODEL: 'nova-2',
  VAPI_TRANSCRIBER_LANGUAGE: 'es-419',
}));

vi.mock('../../../config', () => ({ config: mockConfig }));

import {
  assistantTools,
  systemPrompt,
  DESENLACES_LLAMADA,
  buildAssistant,
  FRASE_DISCULPA_TECNICA,
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

  it('el enum de registrar_resultado tiene exactamente los 7 desenlaces', () => {
    const registrar = assistantTools.find((t) => t.function.name === 'registrar_resultado');
    const desenlaces = registrar?.function.parameters.properties['desenlace']?.enum;

    expect(desenlaces).toEqual([
      'acepto',
      'no_interesado',
      'interesado_sin_espacio',
      'no_contactar',
      'buzon',
      'numero_equivocado',
      'error_tecnico',
    ]);
    expect(desenlaces).toHaveLength(7);
    expect(DESENLACES_LLAMADA).toHaveLength(7);
  });

  it('las tools de agenda llevan SOLO request-response-delayed como mensaje', () => {
    for (const nombre of ['verificar_disponibilidad', 'agendar_cita']) {
      const tool = assistantTools.find((t) => t.function.name === nombre);
      expect(tool?.messages, nombre).toEqual([
        {
          type: 'request-response-delayed',
          content: FRASE_DISCULPA_TECNICA,
          timingMilliseconds: 10_000,
        },
      ]);
      // La frase de respaldo la lee el TTS verbatim: sin "Doctor(a)" ni {{...}}
      expect(FRASE_DISCULPA_TECNICA).not.toMatch(/\(|\)|\{\{/);
    }
  });

  it('NINGUNA tool lleva request-failed (suprime el turno del modelo tras un fallo)', () => {
    // Regresión 11 jul: con request-failed configurado, Vapi habla ese mensaje
    // y NO vuelve a invocar al modelo ("exclusive OR" según la doc de Vapi) —
    // la llamada muere en silence-timed-out sin disculpa ni registrar_resultado.
    for (const tool of assistantTools) {
      const tipos = (tool.messages ?? []).map((m) => m.type as string);
      expect(tipos, tool.function.name).not.toContain('request-failed');
    }
  });

  it('docs/vapi_tools.json es idéntico al código (functions, enums y messages)', () => {
    const raw = readFileSync(path.resolve(process.cwd(), 'docs', 'vapi_tools.json'), 'utf8');
    // El encabezado del doc son líneas de comentario // — no son JSON.
    const sinComentarios = raw
      .split(/\r?\n/)
      .filter((linea) => !linea.trimStart().startsWith('//'))
      .join('\n');
    const doc = JSON.parse(sinComentarios) as Array<{
      function: unknown;
      messages?: unknown;
    }>;

    expect(doc.map((t) => t.function)).toEqual(assistantTools.map((t) => t.function));
    expect(doc.map((t) => t.messages)).toEqual(assistantTools.map((t) => t.messages));
  });

  it('tolera PUBLIC_URL con slash final sin duplicar la diagonal', async () => {
    vi.resetModules();
    vi.doMock('../../../config', () => ({
      config: {
        ...mockConfig,
        PUBLIC_URL: 'https://otro-servicio.onrender.com/',
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
    expect(systemPrompt).toContain(mockConfig.AGENTE_NOMBRE);
    expect(systemPrompt).toContain(mockConfig.EMPRESA_NOMBRE);
    expect(systemPrompt).toContain(mockConfig.TELEFONO_OFICIAL);
  });

  it('no incluye el encabezado instructivo del documento', () => {
    expect(systemPrompt.startsWith('## 1. IDENTIDAD Y ROL')).toBe(true);
    expect(systemPrompt).not.toContain('Pega el bloque');
  });

  it('conserva las variables {{...}} de Vapi (esas las llena Vapi, no el backend)', () => {
    expect(systemPrompt).toContain('{{prospecto_nombre}}');
    expect(systemPrompt).toContain('{{now}}');
  });

  it('la regla de falla técnica prohíbe el silencio tras un error de herramienta', () => {
    // Refuerzo del 11 jul: sin request-failed estático, el cierre hablado tras
    // un fallo depende 100% de esta instrucción del prompt.
    expect(systemPrompt).toContain('"No result returned"');
    expect(systemPrompt).toContain('el silencio está prohibido');
  });
});

// ─── Assistant transient ──────────────────────────────────────────────────────

describe('buildAssistant — assistant transient completo', () => {
  it('lleva el system prompt como primer mensaje del modelo', () => {
    const assistant = buildAssistant();
    expect(assistant.model.messages).toEqual([{ role: 'system', content: systemPrompt }]);
  });

  it('lleva las 4 tools de la especificación más endCall', () => {
    const assistant = buildAssistant();
    const funcionales = assistant.model.tools.filter(
      (t): t is (typeof assistantTools)[number] => t.type === 'function',
    );
    expect(funcionales).toEqual([...assistantTools]);
    expect(funcionales.map((t) => t.function.name)).toEqual([
      'verificar_disponibilidad',
      'agendar_cita',
      'registrar_resultado',
      'marcar_no_contactar',
    ]);
  });

  it('incluye la tool endCall para que el asistente pueda colgar', () => {
    const assistant = buildAssistant();
    expect(assistant.model.tools).toContainEqual({ type: 'endCall' });
    // endCall va al final, después de las tools funcionales
    expect(assistant.model.tools.at(-1)).toEqual({ type: 'endCall' });
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

  it('configura el transcriber en español latinoamericano (Deepgram, desde config)', () => {
    const assistant = buildAssistant();
    expect(assistant.transcriber).toEqual({
      provider: 'deepgram',
      model: mockConfig.VAPI_TRANSCRIBER_MODEL,
      language: mockConfig.VAPI_TRANSCRIBER_LANGUAGE,
    });
    expect(assistant.transcriber.language).toBe('es-419');
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
    expect(assistant.firstMessage).toContain(mockConfig.AGENTE_NOMBRE);
    expect(assistant.firstMessage).toContain(mockConfig.EMPRESA_NOMBRE);
    expect(assistant.firstMessage).toContain('{{prospecto_nombre}}');
  });

  it('el nombre del assistant también sale de AGENTE_NOMBRE', () => {
    const assistant = buildAssistant();
    expect(assistant.name).toBe(mockConfig.AGENTE_NOMBRE);
  });
});
