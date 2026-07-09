import { z } from 'zod';
import { DESENLACES_LLAMADA } from './assistant.config';

// ─── Desenlaces que reporta el asistente de voz ───────────────────────────────
// Fuente única: assistant.config.ts (mismo enum que ve el LLM en la tool
// registrar_resultado). Aquí solo se re-exporta para validación.

export { DESENLACES_LLAMADA } from './assistant.config';
export type { DesenlaceLlamada } from './assistant.config';

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
// Espejo exacto de los parámetros declarados en assistant.config / vapi_tools:
// el leadId NO es argumento — el backend lo recupera de metadata de la llamada.

export const zArgsRegistrarResultado = z.object({
  desenlace: z.enum(DESENLACES_LLAMADA),
  notas: z.string().optional(),
});

export const zArgsMarcarNoContactar = z.object({
  motivo: z.string().optional(),
});

export const zArgsAgendarCita = z.object({
  fecha: z.string().min(1), // YYYY-MM-DD
  hora: z.string().min(1),  // HH:mm
  notas: z.string().optional(),
});

// verificar_disponibilidad no lleva parámetros — no requiere schema.

// ─── Payload completo del webhook de Vapi ────────────────────────────────────
// Vapi envía { message: { type: "tool-calls", toolCallList: [...], call: {...} } }
// junto con otros tipos de mensajes (call-started, call-ended, transcript, etc.)

const zCallInfo = z.object({
  id: z.string(),
  metadata: z.record(z.string()).optional(),
  // El metadata que mandamos al crear la llamada viaja en assistantOverrides
  assistantOverrides: z
    .object({ metadata: z.record(z.string()).optional() })
    .passthrough()
    .optional(),
  endedReason: z.string().optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
}).passthrough(); // Permite campos adicionales sin fallar la validación

export type VapiCallInfo = z.infer<typeof zCallInfo>;

/**
 * Recupera el leadId de la llamada. Única vía de correlación llamada→lead:
 * lo mandamos en assistantOverrides.metadata al crear la llamada y algunos
 * eventos lo exponen aplanado en call.metadata.
 */
export function leadIdDeLlamada(call: VapiCallInfo | undefined): string | undefined {
  return call?.metadata?.['leadId'] ?? call?.assistantOverrides?.metadata?.['leadId'];
}

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
