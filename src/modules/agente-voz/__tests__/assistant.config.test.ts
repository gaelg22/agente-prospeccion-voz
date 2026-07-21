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

  it('agendar_cita requiere fecha, hora, modalidad y consienteWhatsapp', () => {
    const agendar = assistantTools.find((t) => t.function.name === 'agendar_cita');
    expect(agendar?.function.parameters.required).toEqual([
      'fecha',
      'hora',
      'modalidad',
      'consienteWhatsapp',
    ]);
    expect(agendar?.function.parameters.properties['modalidad']?.enum).toEqual([
      'virtual',
      'presencial',
    ]);
  });

  it('agendar_cita declara consienteWhatsapp (boolean) y whatsappAlterno (string opcional)', () => {
    const agendar = assistantTools.find((t) => t.function.name === 'agendar_cita');
    const props = agendar?.function.parameters.properties;

    expect(props?.['consienteWhatsapp']?.type).toBe('boolean');
    // El LLM debe saber que false = cero envíos.
    expect(props?.['consienteWhatsapp']?.description).toContain('no se envía ningún mensaje');

    expect(props?.['whatsappAlterno']?.type).toBe('string');
    // Solo un número dictado Y confirmado por relectura puede viajar aquí.
    expect(props?.['whatsappAlterno']?.description).toContain('confirmó tras la relectura');
    expect(agendar?.function.parameters.required).not.toContain('whatsappAlterno');
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
    // lo hace el Asesor en la cita. El pitch es el encuadre de valor autorizado.
    expect(systemPrompt).toContain('NO presentas ni enumeras productos');
    // Restos del catálogo del guion v1 eliminados.
    expect(systemPrompt).not.toContain('planes de vida y gastos médicos');
    expect(systemPrompt).not.toContain('protección de vida, gastos médicos o ahorro');
  });

  it('el prompt parte la apertura en dos turnos: firstMessage corto + identificación del modelo', () => {
    // 20 jul: la apertura completa de corrido (confirmación + identificación +
    // gancho) en el firstMessage no le daba tiempo al prospecto de contestar
    // ("¿quién habla?"). Ahora el firstMessage SOLO saluda y confirma
    // identidad; el modelo dice la identificación + el gancho en su primer
    // turno hablado, DESPUÉS de que el prospecto confirma que es él.
    const saludoSistema = 'Qué gusto, muy buenas. ¿Hablo con {{prospecto_nombre}}?';
    const identificacion =
      `Le llama ${mockConfig.AGENTE_NOMBRE}, asistente virtual de ${mockConfig.EMPRESA_NOMBRE}. ` +
      'Le marco por algo que muchos profesionistas como usted están aprovechando y que puede interesarle.';
    expect(systemPrompt).toContain(saludoSistema);
    expect(systemPrompt).toContain(identificacion);
    expect(systemPrompt).toContain('NO repitas ni parafrasees nada de esto');
    // Sigue viva la referencia a la regla de compliance de identificarse pronto.
    expect(systemPrompt).toContain('sección 3.1');
    // El saludo del sistema va antes de la identificación del modelo, y esta
    // antes del aviso de privacidad + los treinta segundos (Paso 2).
    expect(systemPrompt.indexOf(saludoSistema)).toBeLessThan(systemPrompt.indexOf(identificacion));
    expect(systemPrompt.indexOf(identificacion)).toBeLessThan(systemPrompt.indexOf('**Paso 2 —'));
    // La identificación como asistente virtual aparece UNA sola vez en el prompt.
    const veces = systemPrompt.split(`asistente virtual de ${mockConfig.EMPRESA_NOMBRE}`).length - 1;
    expect(veces).toBe(1);
  });

  it('el pitch usa el encuadre del asesor y la línea que desarma la venta', () => {
    // Material del asesor (jul 2026): encuadre de temas + "no compre nada".
    expect(systemPrompt).toContain(
      'información de valor para usted y su familia en temas de salud, protección, ahorro y retiro',
    );
    expect(systemPrompt).toContain('a través de una videollamada con uno de nuestros asesores');
    expect(systemPrompt).toContain(
      'No se trata de que compre nada — es una plática sin costo para revisar cómo está protegido hoy.',
    );
    // Al asesor no se le nombra: la identidad pública es solo la empresa.
    expect(systemPrompt).toContain('siempre "uno de nuestros asesores"');
  });

  it('ofrece los días ANTES de preguntar mañana/tarde, y la franja elegida filtra los horarios', () => {
    const ofertaDias = 'Primera oferta — SOLO los días, todavía sin hora';
    const pregunta = '¿Por la mañana o por la tarde?';
    expect(systemPrompt).toContain(ofertaDias);
    expect(systemPrompt).toContain(pregunta);
    // El día se ofrece antes de preguntar la franja.
    expect(systemPrompt.indexOf('Ejecuta `verificar_disponibilidad`')).toBeLessThan(
      systemPrompt.indexOf(ofertaDias),
    );
    expect(systemPrompt.indexOf(ofertaDias)).toBeLessThan(systemPrompt.indexOf(pregunta));
    // El corte de franja es a las 14:00 y la preferencia nunca se ignora.
    expect(systemPrompt).toContain('mañana = horas hasta las 14:00');
    expect(systemPrompt).toContain('tarde = de las 14:00 en adelante');
    expect(systemPrompt).toContain('NUNCA preguntes la franja y luego la ignores');
    // Sin espacios en la franja pedida → se dice y se ofrece la alternativa.
    expect(systemPrompt).toContain('el otro tramo de ese mismo día');
  });

  it('el flujo decide la modalidad por zona antes de agendar y fija la duración', () => {
    // presencial (en zona) = 2 h, videollamada = 1 h; la modalidad se decide en
    // el Paso 4, ANTES de consultar la agenda.
    expect(systemPrompt).toContain('videollamada = **una hora**; presencial = **dos horas**');
    expect(systemPrompt).toContain('«sí»');
    expect(systemPrompt).toContain('«no»');
    expect(systemPrompt).toContain('pasando la `modalidad`');
  });

  it('la modalidad y duración se dicen UNA sola vez — no se repiten al ofrecer días', () => {
    // Feedback tras llamada de prueba: encimar la coletilla de duración/modalidad
    // con la oferta de días saturaba la frase y el prospecto no captaba el día.
    expect(systemPrompt).toContain('UNA sola vez en toda la llamada');
    expect(systemPrompt).toContain('NUNCA la repitas después — ni al ofrecer los días');
    expect(systemPrompt).toContain('NO encimes la modalidad ni la duración aquí');
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

  it('el consentimiento de WhatsApp se pregunta ANTES de agendar_cita, con guion completo', () => {
    // Paso 6: la tool se invoca UNA vez, ya con la respuesta de la persona —
    // por eso la pregunta va antes de ejecutarla (los flags viajan en la tool).
    expect(systemPrompt).toContain('SIEMPRE antes de ejecutar `agendar_cita`');
    expect(systemPrompt).toContain(
      '¿Le gustaría recibir la confirmación de su cita por WhatsApp a este mismo número?',
    );
    // "invitación" confunde al prospecto (feedback tras llamada de prueba) —
    // el mensaje de WhatsApp se llama "confirmación" en todo el prompt.
    expect(systemPrompt).not.toContain('invitación');
    // Captura del alterno: dictado despacio + relectura en bloques + confirmación.
    expect(systemPrompt).toContain('pausa cada dos o tres dígitos');
    expect(systemPrompt).toContain('Le repito el número para confirmar');
    // Máximo dos intentos; el fallback deriva a un asesor y dicta folio de viva voz.
    expect(systemPrompt).toContain('UNA sola vez más');
    expect(systemPrompt).toContain('Nunca hagas un tercer intento');
    expect(systemPrompt).toContain('Una disculpa, no quiero registrar un número incorrecto.');
    // Sin consentimiento (o fallback de dictado) → un asesor contacta directo,
    // con la MISMA frase en ambos casos.
    const fraseAsesor = 'Un asesor se comunicará directamente con usted para darle los datos de la reunión.';
    const apariciones = systemPrompt.split(fraseAsesor).length - 1;
    expect(apariciones).toBeGreaterThanOrEqual(2); // fallback de dictado + cierre sin consentimiento
    // El cierre distingue si el backend realmente envió el WhatsApp.
    expect(systemPrompt).toContain('`whatsappEnviado`');
  });

  it('el folio NUNCA se dice por voz: cero instrucciones de dictarlo en todo el prompt', () => {
    // El valor del folio viaja únicamente en el WhatsApp; Sofía puede anunciar
    // que la confirmación llegará con folio, pero jamás pronunciarlo.
    expect(systemPrompt).toContain('El folio NUNCA se dice por voz');
    expect(systemPrompt).toContain('viaja únicamente en el WhatsApp');
    // Restos de los guiones viejos que pedían dictarlo, eliminados:
    expect(systemPrompt).not.toContain('dictas el folio');
    expect(systemPrompt).not.toContain('el folio en bloques');
    expect(systemPrompt).not.toContain('folio de confirmación:');
    expect(systemPrompt).not.toContain('hora y folio');
    expect(systemPrompt).not.toContain('folio despacio');
    expect(systemPrompt).not.toMatch(/folio y la hora de viva voz|deletrea el folio|repite el folio/i);
  });

  it('el paso de consentimiento no contiene ningún relleno de espera del modelo', () => {
    // La regla de clase de la sección 4 aplica también aquí: ni el guion del
    // dictado ni la relectura pueden colar un "permítame"/"un momento".
    const paso6 = systemPrompt.split('**Paso 6')[1]?.split('**Paso 7')[0] ?? '';
    expect(paso6).toContain('PROHIBIDO cualquier relleno de espera');
    expect(paso6).not.toMatch(/perm[ií]ta|un momento|un segundo|un instante|enseguida/i);
    // La despedida sigue siendo del sistema — el Paso 7 no la agrega.
    const paso7 = systemPrompt.split('**Paso 7')[1]?.split('## 6.')[0] ?? '';
    expect(paso7).toContain('NO agregues la despedida');
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

  it('firstMessage SOLO saluda y confirma identidad — corto, para que el prospecto conteste', () => {
    // 20 jul: la apertura completa de corrido (confirmación + identificación +
    // gancho) no le daba tiempo al prospecto de responder y lo confundía. El
    // firstMessage ahora corta ahí; la identificación + el gancho los dice el
    // modelo DESPUÉS de que el prospecto confirma (Paso 1 del system prompt).
    const assistant = buildAssistant();
    expect(assistant.firstMessage).toBe('Qué gusto, muy buenas. ¿Hablo con {{prospecto_nombre}}?');
    expect(assistant.firstMessage).toContain('{{prospecto_nombre}}');
    // Ya NO identifica ni engancha: eso vive únicamente en el system prompt.
    expect(assistant.firstMessage).not.toContain('asistente virtual');
    expect(assistant.firstMessage).not.toContain(mockConfig.AGENTE_NOMBRE);
    expect(assistant.firstMessage).not.toContain(mockConfig.EMPRESA_NOMBRE);
  });

  it('la identificación vive UNA sola vez, en el system prompt — ya no viaja en el firstMessage', () => {
    const assistant = buildAssistant();
    const vecesEnPrompt = systemPrompt.split(`asistente virtual de ${mockConfig.EMPRESA_NOMBRE}`).length - 1;
    expect(vecesEnPrompt).toBe(1);
    expect(assistant.firstMessage).not.toContain(`asistente virtual de ${mockConfig.EMPRESA_NOMBRE}`);
  });

  it('el nombre del assistant también sale de AGENTE_NOMBRE', () => {
    const assistant = buildAssistant();
    expect(assistant.name).toBe(mockConfig.AGENTE_NOMBRE);
  });
});
