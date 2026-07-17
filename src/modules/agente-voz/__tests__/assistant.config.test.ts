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
  VAPI_VOICE_MODEL: 'eleven_flash_v2_5',
  VAPI_VOICE_STABILITY: 0.45,
  VAPI_VOICE_SIMILARITY: 0.75,
  VAPI_VOICE_STYLE: 0.3,
  VAPI_VOICE_BOOST: true,
  VAPI_TRANSCRIBER_MODEL: 'nova-2',
  VAPI_TRANSCRIBER_LANGUAGE: 'es-419',
  HORARIO_SEMANAL: '-,10-20,10-20,10-20,10-20,10-20,8-12',
}));

vi.mock('../../../config', () => ({ config: mockConfig }));

import {
  assistantTools,
  systemPrompt,
  DESENLACES_LLAMADA,
  buildAssistant,
  FRASE_DISCULPA_TECNICA,
  FRASE_DESPEDIDA_ENDCALL,
  FRASE_RETIRO_NO_CONTACTAR,
  MENSAJE_INICIO_SILENCIOSO,
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

  it('agendar_cita requiere fecha, hora y modalidad', () => {
    const agendar = assistantTools.find((t) => t.function.name === 'agendar_cita');
    expect(agendar?.function.parameters.required).toEqual(['fecha', 'hora', 'modalidad']);
    expect(agendar?.function.parameters.properties['modalidad']?.enum).toEqual([
      'virtual',
      'presencial',
    ]);
  });

  it('verificar_disponibilidad requiere la modalidad (define la duración del slot)', () => {
    const verificar = assistantTools.find((t) => t.function.name === 'verificar_disponibilidad');
    expect(verificar?.function.parameters.required).toEqual(['modalidad']);
    expect(verificar?.function.parameters.properties['modalidad']?.enum).toEqual([
      'virtual',
      'presencial',
    ]);
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

  it('las tools de agenda llevan request-start VACÍO + request-response-delayed', () => {
    // El request-start vacío tapa el filler default de Vapi ("Espera un segundo"/
    // "Solo un segundo" en 019f5cbf) al arrancar la tool; el request-response-delayed
    // es el respaldo hablado si el server no responde en 10 s. La oferta/confirmación
    // dinámica la dice el modelo DESPUÉS del resultado, así que el vacío no la pisa.
    for (const nombre of ['verificar_disponibilidad', 'agendar_cita']) {
      const tool = assistantTools.find((t) => t.function.name === nombre);
      expect(tool?.messages, nombre).toEqual([
        { type: 'request-start', content: '', blocking: false },
        {
          type: 'request-response-delayed',
          content: FRASE_DISCULPA_TECNICA,
          timingMilliseconds: 10_000,
        },
      ]);
      // El request-start es VACÍO: no habla nada (si hablara, pisaría la línea del modelo)
      const start = tool?.messages?.find((m) => m.type === 'request-start');
      expect(start?.content, nombre).toBe('');
      // La frase de respaldo la lee el TTS verbatim: sin "Doctor(a)" ni {{...}}
      expect(FRASE_DISCULPA_TECNICA).not.toMatch(/\(|\)|\{\{/);
    }
  });

  it('marcar_no_contactar mecaniza la línea de retiro con un request-start bloqueante', () => {
    // 019f5c92 (13 jul): el cierre de DNC no puede depender de que el modelo
    // redacte la línea de retiro (la omitió y Vapi coló su filler). Ahora la
    // habla Vapi al arrancar la tool, verbatim y blocking.
    const marcar = assistantTools.find((t) => t.function.name === 'marcar_no_contactar');
    expect(marcar?.messages).toEqual([
      {
        type: 'request-start',
        content: 'Con gusto lo retiro de nuestra lista, una disculpa por la molestia.',
        blocking: true,
      },
    ]);
    expect(marcar?.messages?.[0]).toEqual(FRASE_RETIRO_NO_CONTACTAR);
    // La lee el TTS verbatim: sin "Doctor(a)" ni variables {{...}}
    expect(FRASE_RETIRO_NO_CONTACTAR.content).not.toMatch(/\(|\)|\{\{/);
  });

  it('registrar_resultado lleva un request-start VACÍO que tapa el filler default sin hablar', () => {
    // Se llama en TODO cierre, incluido el AGENDADO EXITOSO donde el modelo dice
    // su línea con folio y fecha reales: por eso el mensaje es VACÍO (no encima
    // audio) y solo existe para que Vapi no inyecte su "Dame un momento".
    const registrar = assistantTools.find((t) => t.function.name === 'registrar_resultado');
    expect(registrar?.messages).toEqual([{ type: 'request-start', content: '', blocking: false }]);
    expect(registrar?.messages?.[0]).toEqual(MENSAJE_INICIO_SILENCIOSO);
    expect(MENSAJE_INICIO_SILENCIOSO.content).toBe('');
  });

  it('agendar_cita solo lleva request-start VACÍO — su confirmación con folio la dice el modelo', () => {
    // Camino feliz intacto: una frase mecánica aquí pisaría la confirmación
    // dinámica de la cita ("queda su cita el… le llega por WhatsApp"). El único
    // request-start es VACÍO (tapa el filler default), no una línea hablada.
    const agendar = assistantTools.find((t) => t.function.name === 'agendar_cita');
    for (const m of agendar?.messages ?? []) {
      if (m.type === 'request-start') expect(m.content).toBe('');
    }
    // Conserva el respaldo técnico request-response-delayed.
    expect(agendar?.messages?.some((m) => m.type === 'request-response-delayed')).toBe(true);
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

  it('el horario de atención sale de HORARIO_SEMANAL, no de texto hardcodeado', async () => {
    // Con el HORARIO_SEMANAL default del mock:
    expect(systemPrompt).toContain(
      'lunes–viernes 10:00–20:00, sábado 08:00–12:00; domingo inhábil',
    );

    // Cambiar la env cambia lo que dice el prompt:
    vi.resetModules();
    vi.doMock('../../../config', () => ({
      config: { ...mockConfig, HORARIO_SEMANAL: '-,9-17,9-17,9-17,9-17,9-17,-' },
    }));
    const mod = await import('../assistant.config');
    expect(mod.systemPrompt).toContain('lunes–viernes 09:00–17:00; sábado–domingo inhábil');
    expect(mod.systemPrompt).not.toContain('10:00–20:00');

    vi.doUnmock('../../../config');
    vi.resetModules();
  });

  it('no incluye el encabezado instructivo del documento', () => {
    expect(systemPrompt.startsWith('## 1. IDENTIDAD Y ROL')).toBe(true);
    expect(systemPrompt).not.toContain('Pega el bloque');
  });

  it('conserva las variables {{...}} que llena Vapi con variableValues del backend', () => {
    expect(systemPrompt).toContain('{{prospecto_nombre}}');
    // La fecha ya NO es el {{now}} de Vapi (llegaba en UTC): la inyecta el
    // backend en zona de México vía variableValues.fecha_hora_actual.
    expect(systemPrompt).toContain('{{fecha_hora_actual}}');
    expect(systemPrompt).not.toContain('{{now}}');
    // Zona presencial: la calcula el backend por lead y viaja como variable.
    expect(systemPrompt).toContain('{{zona_presencial}}');
  });

  it('la postura es de APOYO y ya NO enumera productos ni líneas de negocio', () => {
    // Cambio de reglas de negocio (asesor): Sofía no presenta productos — eso
    // lo hace el Asesor en la cita. El pitch es una sola frase de apoyo.
    expect(systemPrompt).toContain('revisen si están bien protegidos');
    expect(systemPrompt).toContain('NO presentas ni enumeras productos');
    // Restos del catálogo del guion v1 eliminados.
    expect(systemPrompt).not.toContain('planes de vida y gastos médicos');
    expect(systemPrompt).not.toContain('protección de vida, gastos médicos o ahorro');
  });

  it('el flujo decide la modalidad por zona antes de agendar y fija la duración', () => {
    // presencial (en zona) = 2 h, videollamada = 1 h; la modalidad se decide en
    // el Paso 4, ANTES de consultar la agenda.
    expect(systemPrompt).toContain('videollamada = **una hora**; presencial = **dos horas**');
    expect(systemPrompt).toContain('«sí»');
    expect(systemPrompt).toContain('«no»');
    expect(systemPrompt).toContain('pasando la `modalidad`');
  });

  it('la regla de falla técnica prohíbe el silencio tras un error de herramienta', () => {
    // Refuerzo del 11 jul: sin request-failed estático, el cierre hablado tras
    // un fallo depende 100% de esta instrucción del prompt.
    expect(systemPrompt).toContain('"No result returned"');
    expect(systemPrompt).toContain('el silencio está prohibido');
  });

  it('la sección 4 prohíbe los rellenos de espera POR CLASE, no por frases exactas', () => {
    // Llamada 019f57c6 (12 jul): el modelo esquivó la lista de frases exactas
    // parafraseando ("Esto solo tomará un segundo"). La prohibición ahora es
    // por clase — cualquier anuncio de espera/demora en cualquier paráfrasis.
    const seccion4 = systemPrompt.split('## 5.')[0] ?? '';
    expect(seccion4).toContain('PROHIBIDO cualquier anuncio de espera o demora');
    expect(seccion4).toContain('La prohibición es por CLASE, no por frases exactas');
    expect(seccion4).toContain('paráfrasis');
    expect(seccion4).toContain('Las herramientas se ejecutan en silencio siempre');
  });

  it('la objeción de rechazo delega la línea de retiro al sistema (el modelo no la repite)', () => {
    // 019f5c92 (13 jul): con marcar_no_contactar mecanizado, la línea de retiro
    // la habla Vapi al arrancar la tool; el modelo NO debe decirla o se encima.
    expect(systemPrompt).toContain('el sistema dice la línea de retiro');
    expect(systemPrompt).toContain('TÚ no la digas');
    // El modelo ya no pone la línea de retiro COMPLETA en su boca (esquema viejo).
    expect(systemPrompt).not.toContain(
      'di tu línea contextual breve, de viva voz: "Entiendo perfectamente, lo retiro de nuestra lista.',
    );
    // Ya no exige "despedida cortés antes de las herramientas" (esquema viejo).
    expect(systemPrompt).not.toContain('la despedida cortés es OBLIGATORIA antes de las herramientas');
  });

  it('el cierre delega la despedida final al sistema y ya no exige turno de despedida del modelo', () => {
    // Estrategia mecánica (12 jul): tras dos fallos del enfoque por prompt
    // (llamadas 019f53ac y 019f53c3, texto tras endCall que perdió la carrera
    // contra el colgado), la despedida la habla Vapi vía el request-start
    // bloqueante de endCall. El modelo ya no debe decir la despedida final.
    expect(systemPrompt).toContain('La despedida final la dice el SISTEMA, no tú');
    // Restos del esquema de "turno de despedida" eliminados para no confundir.
    expect(systemPrompt).not.toContain('TURNO HABLADO PURO');
    expect(systemPrompt).not.toContain('PROHIBIDO mezclar despedida y herramientas en el mismo turno');
  });

  it('el cierre exige SOLO la línea contextual y cero texto de transición hacia las tools', () => {
    // Causa raíz de 019f57c6 (12 jul): el modelo coló un relleno ("Esto solo
    // tomará un segundo") en el mismo turno que endCall, antes de la despedida
    // mecánica. La regla ataca la clase: solo la línea del desenlace, nada más.
    expect(systemPrompt).toContain('cero texto de transición hacia las herramientas');
    expect(systemPrompt).toContain('El turno de `endCall` no lleva texto propio del modelo');
  });
});

// ─── Assistant transient ──────────────────────────────────────────────────────

describe('buildAssistant — assistant transient completo', () => {
  it('lleva el system prompt como primer mensaje del modelo', () => {
    const assistant = buildAssistant();
    expect(assistant.model.messages).toEqual([{ role: 'system', content: systemPrompt }]);
  });

  it('declara serverMessages: default de Vapi + transcript SOLO final', () => {
    const assistant = buildAssistant();
    // tool-calls es vital — sin él las tools dejan de llegar al webhook.
    expect(assistant.serverMessages).toContain('tool-calls');
    // Solo transcripciones finales; el default de Vapi no manda 'transcript'.
    expect(assistant.serverMessages).toContain('transcript[transcriptType="final"]');
    expect(assistant.serverMessages).not.toContain('transcript');
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

  it('incluye la tool endCall con el mensaje de despedida bloqueante para colgar', () => {
    const assistant = buildAssistant();
    const endCall = { type: 'endCall', messages: [FRASE_DESPEDIDA_ENDCALL] };
    expect(assistant.model.tools).toContainEqual(endCall);
    // endCall va al final, después de las tools funcionales
    expect(assistant.model.tools.at(-1)).toEqual(endCall);
  });

  it('el mensaje de endCall es request-start bloqueante: Vapi lo habla COMPLETO antes de colgar', () => {
    // Garantía mecánica (12 jul): con blocking:true el colgado solo se dispara
    // tras hablar la frase ("the tool call will only trigger after the message
    // is spoken", ToolMessageStart.blocking en api.vapi.ai/api-json). Es lo que
    // el enfoque por prompt no logró: en 019f53ac/019f53c3 el texto tras endCall
    // perdió la carrera contra el colgado y se escuchó cortado.
    expect(FRASE_DESPEDIDA_ENDCALL).toEqual({
      type: 'request-start',
      content: 'Gracias por su tiempo. Que tenga excelente día.',
      blocking: true,
    });
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

  it('configura la voz ElevenLabs con voiceId, modelo TTS y settings desde config', () => {
    const assistant = buildAssistant();
    expect(assistant.voice).toEqual({
      provider: '11labs',
      voiceId: 'voz-de-prueba',
      model: 'eleven_flash_v2_5',
      stability: 0.45,
      similarityBoost: 0.75,
      style: 0.3,
      useSpeakerBoost: true,
    });
  });

  it('apaga el backgroundSound (el ambiente de oficina default de Vapi mete ruido)', () => {
    const assistant = buildAssistant();
    expect(assistant.backgroundSound).toBe('off');
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
