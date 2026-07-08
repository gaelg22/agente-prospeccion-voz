import { z } from 'zod';

// ─── Desenlaces que reporta el asistente de voz ───────────────────────────────
// El asistente llama a registrar_resultado con uno de estos valores.

export const DESENLACES_LLAMADA = [
  'interesado',           // quiere saber más / agendar cita
  'no_interesado',        // rechazó explícitamente el producto
  'no_contesto',          // no levantó el teléfono
  'buzon',                // fue directo a buzón
  'no_contactar',         // pidió que no le llamen más
  'numero_incorrecto',    // número equivocado / fuera de servicio
  'interesado_sin_espacio', // interesado pero sin disponibilidad esta semana
] as const;

export type DesenlaceLlamada = (typeof DESENLACES_LLAMADA)[number];

// ─── Tool-call individual ─────────────────────────────────────────────────────

export const zToolCall = z.object({
  id: z.string(),                    // toolCallId — se devuelve en results
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.record(z.unknown()), // parseamos por tool
  }),
});

export type VapiToolCall = z.infer<typeof zToolCall>;

// ─── Argumentos tipados por tool ──────────────────────────────────────────────

export const zArgsRegistrarResultado = z.object({
  leadId: z.string().min(1),
  desenlace: z.enum(DESENLACES_LLAMADA),
  nota: z.string().optional(),
});

export const zArgsMarcarNoContactar = z.object({
  leadId: z.string().min(1),
  razon: z.string().optional(),
});

export const zArgsAgendarCita = z.object({
  leadId: z.string().min(1),
  fechaPreferida: z.string().optional(), // ISO date suggestion from assistant
  horaPreferida: z.string().optional(),  // e.g. "10:00"
});

export const zArgsVerificarDisponibilidad = z.object({
  fecha: z.string(),  // YYYY-MM-DD
});

// ─── Payload completo del webhook de Vapi ────────────────────────────────────
// Vapi envía { message: { type: "tool-calls", toolCalls: [...], call: {...} } }
// junto con otros tipos de mensajes (call-started, call-ended, transcript, etc.)

const zCallInfo = z.object({
  id: z.string(),
  metadata: z.record(z.string()).optional(),
  endedReason: z.string().optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
}).passthrough(); // Permite campos adicionales sin fallar la validación

export const zVapiToolCallsMessage = z.object({
  message: z.object({
    type: z.literal('tool-calls'),
    toolCallList: z.array(zToolCall).min(1),
    call: zCallInfo.optional(),
  }),
});

// Schema permisivo para todos los mensajes Vapi — el handler discrimina por type
export const zVapiWebhookBody = z.object({
  message: z.object({
    type: z.string(),
    toolCallList: z.array(zToolCall).optional(),
    call: zCallInfo.optional(),
    transcript: z.string().optional(),
    role: z.enum(['assistant', 'user']).optional(),
  }),
});

export type VapiWebhookBody = z.infer<typeof zVapiWebhookBody>;

// ─── Formato de respuesta de Vapi para tool results ───────────────────────────
// Vapi espera: { results: [{ toolCallId, result }] }

export interface VapiToolResult {
  toolCallId: string;
  result: string;   // string JSON o texto plano
}

export interface VapiToolCallsResponse {
  results: VapiToolResult[];
}
