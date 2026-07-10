import { readFileSync } from 'fs';
import path from 'path';
import { config } from '../../config';

// ─── Tipos de tools de Vapi ───────────────────────────────────────────────────

export interface VapiToolProperty {
  type: 'string';
  description: string;
  enum?: readonly string[];
}

// Mensaje que Vapi dice de viva voz durante el ciclo de una tool.
// request-failed suena cuando el server no responde o regresa error — evita el
// silencio incómodo mientras el modelo decide cómo seguir. Formato vigente
// verificado en https://docs.vapi.ai/api-reference/tools/create (jul 2026).
export interface VapiToolMessage {
  type: 'request-failed';
  content: string;
}

export interface VapiTool {
  type: 'function';
  messages?: readonly VapiToolMessage[];
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
// la despedida el asistente se queda mudo en la línea hasta que cuelga el
// prospecto. (Reemplaza al booleano legado endCallFunctionEnabled.)
export interface VapiEndCallTool {
  type: 'endCall';
}

export const endCallTool: VapiEndCallTool = { type: 'endCall' };

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

// ─── Tools del asistente ──────────────────────────────────────────────────────
// Especificación de referencia: docs/vapi_tools.json — nombres, descripciones,
// parámetros y enums deben mantenerse idénticos a ese documento.

export const assistantTools: readonly VapiTool[] = [
  {
    type: 'function',
    messages: [
      {
        type: 'request-failed',
        content: 'Deme un momentito, por favor.',
      },
    ],
    function: {
      name: 'verificar_disponibilidad',
      description:
        'Consulta la agenda del asesor y regresa hasta dos días con su ventana de horas libres para cita por videollamada. SIEMPRE llamar antes de ofrecer cualquier horario al prospecto.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    server: webhookServer,
  },
  {
    type: 'function',
    messages: [
      {
        type: 'request-failed',
        content: 'Deme un momentito, por favor.',
      },
    ],
    function: {
      name: 'agendar_cita',
      description:
        'Agenda la cita por videollamada en el día y hora que el prospecto confirmó de viva voz. Solo llamar con día y hora ya aceptados por la persona, y que hayan sido ofrecidos por verificar_disponibilidad. Regresa el folio de confirmación.',
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
          notas: {
            type: 'string',
            description:
              "Opcional: producto de interés u observaciones dichas por el prospecto (ej. 'gastos médicos, para él y su esposa', 'no tiene WhatsApp')",
          },
        },
        required: ['fecha', 'hora'],
      },
    },
    server: webhookServer,
  },
  {
    type: 'function',
    function: {
      name: 'registrar_resultado',
      description:
        'Registra el desenlace final de la llamada. OBLIGATORIO llamarla al final de toda llamada, sin excepción, DESPUÉS de decir la despedida completa y justo antes de colgar con endCall. Se ejecuta en silencio: nunca anuncies que la vas a usar ni pidas esperar.',
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
  };
  server: VapiTool['server'];
}

export function buildAssistant(): VapiTransientAssistant {
  return {
    name: config.AGENTE_NOMBRE,
    // Apertura del Paso 1 del prompt. {{prospecto_nombre}} lo sustituye Vapi
    // con assistantOverrides.variableValues, igual que en el system prompt.
    firstMessage: `Hola, buenas. Le llama ${config.AGENTE_NOMBRE}, asistente virtual de ${config.EMPRESA_NOMBRE}. ¿Hablo con {{prospecto_nombre}}?`,
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
    // eleven_multilingual_v2 habla español con cualquier voz de ElevenLabs.
    // Si la latencia de voz resulta alta, la alternativa es eleven_flash_v2_5.
    voice: {
      provider: '11labs',
      voiceId: config.VAPI_VOICE_ID,
      model: 'eleven_multilingual_v2',
    },
    server: webhookServer,
  };
}
