import { readFileSync } from 'fs';
import path from 'path';
import { config } from '../../config';
import { describirHorarioSemanal } from '../../lib/horario';
import { MODALIDADES } from '../agenda/modalidad';

// ─── Tipos de tools de Vapi ───────────────────────────────────────────────────

export interface VapiToolProperty {
  type: 'string' | 'boolean';
  description: string;
  enum?: readonly string[];
}

// Mensaje que Vapi dice de viva voz durante el ciclo de una tool.
// - request-response-delayed: suena si el server no ha respondido después de
//   timingMilliseconds — respaldo hablado para cuando el server está colgado.
//   NO suprime el turno del modelo: cuando la respuesta (o el fallo) por fin
//   llega, el modelo sigue conversando normal.
// - request-failed NO se usa NUNCA (por eso no está en el tipo): según
//   https://docs.vapi.ai/api-reference/tools/create (jul 2026) ese mensaje
//   REEMPLAZA el turno del modelo — "only this message will be spoken and the
//   model will not be requested to come up with a response. It's an exclusive
//   OR" — y, a diferencia de request-complete, no acepta role:"system" para
//   devolverle la palabra al modelo. Con él configurado, tras un fallo el LLM
//   jamás vuelve a hablar ni ejecuta registrar_resultado (llamada de prueba
//   del 11 jul: murió por silence-timed-out). El error debe llegarle LIMPIO
//   al modelo para que aplique la REGLA DE FALLA TÉCNICA (sección 7 del
//   prompt).
export interface VapiToolMessage {
  type: 'request-response-delayed';
  content: string;
  timingMilliseconds?: number;
}

// request-start: Vapi lo habla al ARRANCAR la tool, ANTES de ejecutarla. En las
// tools de CIERRE cumple dos funciones según su content:
//  - content real + blocking:true → MECANIZA la línea contextual: la pronuncia
//    Vapi verbatim (no el modelo), misma garantía determinista que la despedida
//    de endCall. El colgado/ejecución solo ocurre tras hablarla completa.
//  - content vacío → SUPRIME el filler por defecto que Vapi inyecta cuando una
//    tool no trae messages. Ese default es uno de "Hold on a sec"/"One moment"/
//    "Give me a moment"/"Just a sec"/"This'll just take a sec" (spec de
//    ToolMessageStart) — que la voz en español pronunció como "Dame un momento"
//    en la llamada 019f5c92 (13 jul), justo porque marcar_no_contactar y
//    registrar_resultado no llevaban messages. Ref: https://docs.vapi.ai/api-reference/tools/create
export interface VapiToolStartMessage {
  type: 'request-start';
  content: string;
  blocking: boolean;
}

export interface VapiTool {
  type: 'function';
  messages?: readonly (VapiToolMessage | VapiToolStartMessage)[];
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, VapiToolProperty>;
      required: readonly string[];
    };
  };
  server: {
    url: string;
    secret: string;
  };
}

// Tool nativa de Vapi: permite al asistente colgar la llamada. Sin ella, tras
// el cierre el asistente se queda mudo en la línea hasta que cuelga el
// prospecto. (Reemplaza al booleano legado endCallFunctionEnabled.)
//
// El request-start con blocking: true es la garantía MECÁNICA de la despedida:
// Vapi habla el mensaje COMPLETO antes de ejecutar el colgado ("the tool call
// will only trigger after the message is spoken" — ToolMessageStart.blocking,
// spec en api.vapi.ai/api-json, jul 2026). Por prompt no se pudo garantizar:
// en las llamadas 019f53ac y 019f53c3 (11 jul) el modelo mezcló texto y tools
// en un mismo turno y la despedida generada tras endCall perdió la carrera
// contra el colgado (se escuchó cortada o no se escuchó).
export interface VapiEndCallToolMessage {
  type: 'request-start';
  content: string;
  blocking: true;
}

export interface VapiEndCallTool {
  type: 'endCall';
  messages: readonly [VapiEndCallToolMessage];
}

// El TTS lo lee VERBATIM al colgar — sin variables {{...}} ni "Doctor(a)".
export const FRASE_DESPEDIDA_ENDCALL: VapiEndCallToolMessage = {
  type: 'request-start',
  content: 'Gracias por su tiempo. Que tenga excelente día.',
  blocking: true,
};

export const endCallTool: VapiEndCallTool = {
  type: 'endCall',
  messages: [FRASE_DESPEDIDA_ENDCALL],
};

// ─── Desenlaces de llamada ────────────────────────────────────────────────────
// Alineados a la máquina de estados del backend + casos operativos de llamada
// (buzon y numero_equivocado se resuelven en call-outcome.handler).

export const DESENLACES_LLAMADA = [
  'acepto',
  'no_interesado',
  'interesado_sin_espacio',
  'no_contactar',
  'buzon',
  'numero_equivocado',
  'error_tecnico',
] as const;

export type DesenlaceLlamada = (typeof DESENLACES_LLAMADA)[number];

// ─── Server target compartido por las 4 tools ────────────────────────────────
// URL construida desde PUBLIC_URL — el placeholder del doc nunca llega a Vapi.
// El secret hace que Vapi mande el header x-vapi-secret que valida el webhook.

const webhookServer: VapiTool['server'] = {
  url: `${config.PUBLIC_URL.replace(/\/+$/, '')}/webhooks/vapi`,
  secret: config.VAPI_WEBHOOK_SECRET,
};

// ─── Mensajes de las tools de agenda ─────────────────────────────────────────
// Dos mensajes, sin encimar la voz del modelo (que dice su oferta de horarios y
// su confirmación con folio DESPUÉS del resultado de la tool):
//
// 1) request-start VACÍO (MENSAJE_INICIO_SILENCIOSO): tapa el filler por defecto
//    que Vapi inyecta al ARRANCAR una tool sin request-start — uno de "Hold on a
//    sec"/"One moment"/"Give me a moment"/"Just a sec"/"This'll just take a sec"
//    (spec ToolMessageStart), que la voz en español dijo como "Espera un segundo"/
//    "Solo un segundo" antes de verificar_disponibilidad y agendar_cita (artifact
//    019f5cbf, 13 jul). Confirmado filler default: NO es el request-response-delayed
//    (esa es la disculpa larga a los 10 s) ni texto del modelo (sobrevivió a la
//    prohibición por clase del prompt, que sí silenció el cierre de la llamada DNC).
//
// 2) request-response-delayed: único respaldo hablado si el server no responde en
//    10 s (colgado); el prospecto nunca escucha silencio y, cuando el request
//    resuelve o falla, el resultado llega al modelo y él cierra según la sección 7
//    del prompt. El fallo RÁPIDO (DNS muerto, conexión rechazada) NO lleva mensaje
//    estático a propósito: el error le llega directo al modelo, que habla la
//    disculpa y ejecuta registrar_resultado — un request-failed aquí lo dejaría
//    mudo (ver el tipo VapiToolMessage). La disculpa se lee VERBATIM por el TTS,
//    así que no puede llevar "Doctor(a)" ni variables {{...}}.

export const FRASE_DISCULPA_TECNICA =
  'Le ofrezco una disculpa, estoy teniendo un detalle técnico con la agenda en este momento. Para no hacerle perder tiempo, le llamamos más tarde para confirmarle su cita. Gracias por su paciencia.';

// request-start VACÍO reutilizable: no habla (content ''), solo ocupa el hueco de
// messages para suprimir el filler por defecto de Vapi. blocking:false porque no
// hay nada que hablar. Lo usan las tools cuya línea real la dice el modelo DESPUÉS
// del resultado: verificar_disponibilidad y agendar_cita (antes de la oferta y la
// confirmación dinámicas) y registrar_resultado (en el cierre, incluido el
// AGENDADO EXITOSO, sin pisar la línea con folio y fecha reales del modelo).
export const MENSAJE_INICIO_SILENCIOSO: VapiToolStartMessage = {
  type: 'request-start',
  content: '',
  blocking: false,
};

const mensajesAgenda: readonly (VapiToolStartMessage | VapiToolMessage)[] = [
  MENSAJE_INICIO_SILENCIOSO,
  { type: 'request-response-delayed', content: FRASE_DISCULPA_TECNICA, timingMilliseconds: 10_000 },
];

// ─── Mensajes de cierre mecánicos (request-start) ─────────────────────────────
// Reproducen el patrón de la despedida de endCall en las tools de cierre SIN
// datos dinámicos, para que el audio del cierre no dependa de que el modelo
// redacte la frase en vivo (falló en 019f5c92: el modelo omitió la línea de
// retiro y Vapi coló su filler por defecto "Dame un momento").
//
// marcar_no_contactar → línea de RETIRO, hablada por Vapi (blocking) al arrancar
// la tool. El modelo YA NO la dice (el prompt se lo prohíbe para no encimarla):
// solo la dice el sistema aquí. El TTS la lee verbatim: sin "Doctor(a)" ni {{...}}.
export const FRASE_RETIRO_NO_CONTACTAR: VapiToolStartMessage = {
  type: 'request-start',
  content: 'Con gusto lo retiro de nuestra lista, una disculpa por la molestia.',
  blocking: true,
};

// ─── Tools del asistente ──────────────────────────────────────────────────────
// Especificación de referencia: docs/vapi_tools.json — nombres, descripciones,
// parámetros y enums deben mantenerse idénticos a ese documento.

export const assistantTools: readonly VapiTool[] = [
  {
    type: 'function',
    messages: mensajesAgenda,
    function: {
      name: 'verificar_disponibilidad',
      description:
        'Consulta la agenda del asesor y regresa hasta dos días con su ventana de horas libres para la modalidad ya elegida. La duración de los espacios depende de la modalidad (videollamada = 1 hora, presencial = 2 horas), así que la modalidad debe decidirse ANTES de llamar esta herramienta. SIEMPRE llamar antes de ofrecer cualquier horario al prospecto.',
      parameters: {
        type: 'object',
        properties: {
          modalidad: {
            type: 'string',
            enum: MODALIDADES,
            description:
              'Modalidad ya elegida de la cita: "virtual" (videollamada, 1 hora) o "presencial" (2 horas). Fuera de la zona presencial del asesor siempre es "virtual".',
          },
        },
        required: ['modalidad'],
      },
    },
    server: webhookServer,
  },
  {
    type: 'function',
    messages: mensajesAgenda,
    function: {
      name: 'agendar_cita',
      description:
        'Agenda la cita en el día y hora que el prospecto confirmó de viva voz, en la modalidad elegida (videollamada o presencial). Solo llamar con día y hora ya aceptados por la persona, ofrecidos por verificar_disponibilidad, y DESPUÉS de preguntarle si desea recibir la invitación por WhatsApp. Regresa el folio de confirmación y whatsappEnviado (si es false, di que un asesor se comunicará directamente con la persona; el folio NUNCA se dice por voz). Si falla, regresa "codigo": "SLOT_OCUPADO" (el horario se ocupó justo antes de confirmar — no es falla técnica, vuelve a ofrecer otra hora con verificar_disponibilidad) o "ERROR_TECNICO" (falla real de Calendar/red — aplica la disculpa técnica).',
      parameters: {
        type: 'object',
        properties: {
          fecha: {
            type: 'string',
            description: 'Fecha de la cita en formato YYYY-MM-DD, zona America/Mexico_City',
          },
          hora: {
            type: 'string',
            description:
              'Hora de inicio en formato HH:mm de 24 horas (ej. 17:00). Debe ser una hora en punto dentro de la ventana ofrecida',
          },
          modalidad: {
            type: 'string',
            enum: MODALIDADES,
            description:
              'Modalidad de la cita: "virtual" (videollamada, 1 hora) o "presencial" (2 horas). Debe ser la misma que se usó en verificar_disponibilidad.',
          },
          consienteWhatsapp: {
            type: 'boolean',
            description:
              'true SOLO si la persona aceptó de viva voz recibir la invitación por WhatsApp; false si no quiere WhatsApp o si no se pudo confirmar un número alterno correcto. Con false no se envía ningún mensaje.',
          },
          whatsappAlterno: {
            type: 'string',
            description:
              'Opcional: número alterno para el WhatsApp, SOLO si la persona lo dictó y lo confirmó tras la relectura de viva voz (diez dígitos de México, ej. 4921112233). Omitir para usar el número de la llamada.',
          },
          notas: {
            type: 'string',
            description:
              "Opcional: observaciones dichas por el prospecto (ej. 'para él y su esposa', 'no tiene WhatsApp')",
          },
        },
        required: ['fecha', 'hora', 'modalidad', 'consienteWhatsapp'],
      },
    },
    server: webhookServer,
  },
  {
    type: 'function',
    messages: [MENSAJE_INICIO_SILENCIOSO],
    function: {
      name: 'registrar_resultado',
      description:
        'Registra el desenlace final de la llamada. OBLIGATORIO llamarla al final de toda llamada, sin excepción, DESPUÉS de decir tu línea contextual de cierre y justo antes de colgar con endCall (la despedida final la dice el sistema al colgar). Se ejecuta en silencio: nunca anuncies que la vas a usar ni pidas esperar.',
      parameters: {
        type: 'object',
        properties: {
          desenlace: {
            type: 'string',
            enum: DESENLACES_LLAMADA,
            description:
              'acepto = agendó cita · no_interesado = rechazó · interesado_sin_espacio = quería pero ningún horario le quedó · no_contactar = pidió no ser contactado · buzon = contestó buzón de voz · numero_equivocado = no era la persona · error_tecnico = una herramienta falló o no respondió y no se pudo verificar/agendar (el sistema devuelve la llamada)',
          },
          notas: {
            type: 'string',
            description:
              "Opcional: contexto breve del desenlace (ej. 'pidió llamar en agosto', 'el número es de otra persona')",
          },
        },
        required: ['desenlace'],
      },
    },
    server: webhookServer,
  },
  {
    type: 'function',
    messages: [FRASE_RETIRO_NO_CONTACTAR],
    function: {
      name: 'marcar_no_contactar',
      description:
        'Marca al prospecto como NO CONTACTAR de forma permanente. Llamar en el instante en que la persona pida no recibir más llamadas, ser borrada de la lista, o exprese molestia por el contacto. Es irreversible desde la llamada.',
      parameters: {
        type: 'object',
        properties: {
          motivo: {
            type: 'string',
            description: "Opcional: frase breve de cómo lo pidió (ej. 'pidió borrar su número')",
          },
        },
        required: [],
      },
    },
    server: webhookServer,
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────
// Fuente: docs/system_prompt_vapi_v2.md. Se lee una sola vez al importar el
// módulo (arranque del proceso), no en cada llamada.

const PROMPT_PATH = path.resolve(process.cwd(), 'docs', 'system_prompt_vapi_v2.md');

function cargarSystemPrompt(): string {
  const raw = readFileSync(PROMPT_PATH, 'utf8');

  // El encabezado del doc (antes del primer '---') es instructivo para el
  // dashboard de Vapi, no forma parte del prompt.
  const lineas = raw.split(/\r?\n/);
  const separador = lineas.findIndex((linea) => linea.trim() === '---');
  const cuerpo = (separador === -1 ? lineas : lineas.slice(separador + 1)).join('\n').trim();

  const sustituciones: Record<string, string> = {
    '[NOMBRE_AGENTE]': config.AGENTE_NOMBRE,
    '[NOMBRE_EMPRESA/ASESOR]': config.EMPRESA_NOMBRE,
    '[TELEFONO_OFICIAL / CANAL_OFICIAL]': config.TELEFONO_OFICIAL,
    // Horario generado de la misma tabla que gobierna slots y ventana de
    // llamadas (env HORARIO_SEMANAL) — el prompt nunca recita un horario viejo.
    '[HORARIO_ATENCION]': describirHorarioSemanal(),
  };

  let prompt = cuerpo;
  for (const [marcador, valor] of Object.entries(sustituciones)) {
    prompt = prompt.split(marcador).join(valor);
  }

  // Fail-fast: ningún placeholder [EN CORCHETES] puede llegar a Vapi.
  const sobrante = /\[[A-ZÁÉÍÓÚÜÑ_/ ]+\]/.exec(prompt);
  if (sobrante) {
    throw new Error(
      `System prompt con placeholder sin sustituir: ${sobrante[0]} — revisa docs/system_prompt_vapi_v2.md y las envs AGENTE_NOMBRE / EMPRESA_NOMBRE / TELEFONO_OFICIAL`,
    );
  }

  return prompt;
}

export const systemPrompt = cargarSystemPrompt();

// ─── Defaults de variables del prompt ─────────────────────────────────────────
// El prompt usa {{prospecto_nombre}} y {{especialidad}} (Vapi las sustituye con
// assistantOverrides.variableValues). Estos defaults aplican cuando el lead no
// trae el dato.

export const VARIABLES_DEFAULT = {
  prospecto_nombre: 'doctor(a)',
  especialidad: 'servicios profesionales',
  // ¿El lead cae en la zona presencial del asesor? Lo calcula el backend por
  // lead (lib/zona-presencial). "no" es el default seguro: sin señal de zona,
  // Sofía ofrece videollamada directa sin preguntar modalidad.
  zona_presencial: 'no',
} as const;

// ─── Assistant transient ──────────────────────────────────────────────────────
// Se manda completo en cada POST /call (nada vive en el dashboard de Vapi):
// prompt + tools + modelo + server para que TODOS los eventos de la llamada
// lleguen a nuestro webhook.

export interface VapiTransientAssistant {
  name: string;
  firstMessage: string;
  model: {
    provider: 'anthropic';
    model: string;
    messages: ReadonlyArray<{ role: 'system'; content: string }>;
    tools: ReadonlyArray<VapiTool | VapiEndCallTool>;
  };
  transcriber: {
    provider: 'deepgram';
    model: string;
    language: string;
  };
  voice: {
    provider: '11labs';
    voiceId: string;
    model: string;
    stability: number;
    similarityBoost: number;
    style: number;
    useSpeakerBoost: boolean;
  };
  // 'off' | 'office' | URL de audio. Sin declararlo, Vapi mete ambiente de
  // oficina por default en llamadas telefónicas y se escucha como ruido.
  backgroundSound: 'off';
  serverMessages: readonly string[];
  server: VapiTool['server'];
}

// Eventos que Vapi manda al webhook. El default de Vapi NO incluye 'transcript'
// (verificado docs.vapi.ai, jul 2026): sin declarar esto ninguna línea de
// transcripción llega al server. Se piden SOLO las finales con la variante
// transcript[transcriptType="final"] — los partials duplicarían cada frase.
// El resto replica el default de Vapi para no cambiar el comportamiento actual.
export const SERVER_MESSAGES = [
  'conversation-update',
  'end-of-call-report',
  'function-call',
  'hang',
  'speech-update',
  'status-update',
  'tool-calls',
  'transfer-destination-request',
  'user-interrupted',
  'transcript[transcriptType="final"]',
] as const;

export function buildAssistant(): VapiTransientAssistant {
  return {
    name: config.AGENTE_NOMBRE,
    // SOLO saludo + confirmación de identidad: corto, para que el prospecto
    // conteste antes de que siga la identificación + el gancho. La apertura
    // completa de corrido (confirmación + identificación + gancho) confundía
    // al prospecto — no alcanzaba a responder y preguntó "¿quién habla?"
    // (llamada de prueba del 20 jul). El Paso 1 del system prompt dice la
    // identificación + el gancho en el primer turno del modelo, DESPUÉS de
    // que la persona confirma que es ella.
    // {{prospecto_nombre}} lo sustituye Vapi con assistantOverrides.variableValues.
    firstMessage: 'Qué gusto, muy buenas. ¿Hablo con {{prospecto_nombre}}?',
    model: {
      provider: 'anthropic',
      model: config.VAPI_LLM_MODEL,
      messages: [{ role: 'system', content: systemPrompt }],
      // endCall al final: sin ella el asistente no puede colgar y se queda
      // mudo en la línea después de despedirse.
      tools: [...assistantTools, endCallTool],
    },
    // Español latinoamericano — sin esto Vapi usa defaults pensados para
    // inglés y la transcripción del acento mexicano se degrada.
    transcriber: {
      provider: 'deepgram',
      model: config.VAPI_TRANSCRIBER_MODEL,
      language: config.VAPI_TRANSCRIBER_LANGUAGE,
    },
    // eleven_flash_v2_5 (default de config): mejor pronunciación de español y
    // menor latencia que eleven_multilingual_v2, que recortaba "García" a
    // "Garc". Intercambiable vía env VAPI_VOICE_MODEL sin tocar código, igual
    // que los cuatro settings de ElevenLabs (estabilidad/expresión de la voz).
    voice: {
      provider: '11labs',
      voiceId: config.VAPI_VOICE_ID,
      model: config.VAPI_VOICE_MODEL,
      stability: config.VAPI_VOICE_STABILITY,
      similarityBoost: config.VAPI_VOICE_SIMILARITY,
      style: config.VAPI_VOICE_STYLE,
      useSpeakerBoost: config.VAPI_VOICE_BOOST,
    },
    // Sin esto Vapi agrega ambiente de oficina a la llamada ("mucho ruido"
    // reportado en las pruebas del 11 jul).
    backgroundSound: 'off',
    serverMessages: SERVER_MESSAGES,
    server: webhookServer,
  };
}
