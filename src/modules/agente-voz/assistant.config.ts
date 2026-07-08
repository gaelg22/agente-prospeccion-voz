import { readFileSync } from 'fs';
import path from 'path';
import { config } from '../../config';

// ─── Tipos de tools de Vapi ───────────────────────────────────────────────────

export interface VapiToolProperty {
  type: 'string';
  description: string;
  enum?: readonly string[];
}

export interface VapiTool {
  type: 'function';
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
        'Registra el desenlace final de la llamada. OBLIGATORIO llamarla al final de toda llamada, sin excepción, justo antes de despedirse o colgar.',
      parameters: {
        type: 'object',
        properties: {
          desenlace: {
            type: 'string',
            enum: DESENLACES_LLAMADA,
            description:
              'acepto = agendó cita · no_interesado = rechazó · interesado_sin_espacio = quería pero ningún horario le quedó · no_contactar = pidió no ser contactado · buzon = contestó buzón de voz · numero_equivocado = no era la persona',
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
